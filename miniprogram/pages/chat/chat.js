/**
 * Chat page — structured block rendering
 *
 * Each parsed message contains a `blocks` array with typed objects:
 *   - { type: 'text', text, segments }
 *   - { type: 'tool-call', toolId, name, input, inputDisplay, state, result, resultDisplay, expanded, diff, isError }
 *   - { type: 'permission', requestId, tool, input, questions, selectedAnswers }
 */

const { createParser, formatTime, isObject, generateId, unwrapEnvelope } = require('../../utils/message-parser')

// Create a parser instance for this page
const parser = createParser()

// ── Page-specific utility functions ──

// Read file as base64, compatible with developer tools (http://tmp/) and real devices
function readFileAsBase64(filePath) {
  return new Promise((resolve, reject) => {
    if (filePath.startsWith('http://')) {
      // Developer tools uses http:// virtual paths
      wx.request({
        url: filePath,
        responseType: 'arraybuffer',
        success: (res) => resolve(wx.arrayBufferToBase64(res.data)),
        fail: reject,
      })
    } else {
      wx.getFileSystemManager().readFile({
        filePath,
        encoding: 'base64',
        success: (res) => resolve(res.data),
        fail: reject,
      })
    }
  })
}

function isImageExt(ext) {
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)
}

// ── Page ──

Page({
  data: {
    sessionId: '',
    messages: [],
    inputText: '',
    thinking: false,
    thinkingSeconds: 0,
    sending: false,
    scrollToId: '',
    aborting: false,
    uploading: false,
    selectedImage: null, // { path, base64 }
    remoteControlled: false,
    yoloMode: false,
    queuedCount: 0,
    wallpaperClass: '',
    wallpaperCustomPath: '',
    cardMode: false,
    phoneModal: { visible: false, actionId: '', tool: '', params: {} },
    showShortcutPopup: false,
    showActionMenu: false,
    shortcutList: [],
    editingShortcut: null,
    editingIndex: -1,
    compacting: false,
    compactProgress: 0,
    visibleTimeIdx: -1,
    shareImagePath: '',
    selecting: false,
    selectedIds: [],
    loadingMore: false,
  },

  // Thinking timer (not reactive, stored on page instance)
  _thinkingTimer: null,
  _thinkingStartTime: 0,
  _isNearBottom: true,
  _viewportHeight: 0,
  _lastMsgHash: '',
  _aborted: false,
  _hasMoreMessages: false,
  _nextBeforeSeq: null,
  _loadingMore: false,

  _messagesChanged(prev, next) {
    // Quick check: compare last message text/id
    const pLast = prev[prev.length - 1]
    const nLast = next[next.length - 1]
    if (!pLast || !nLast) return true
    // Different ID means new message arrived
    if (pLast.id !== nLast.id) return true
    // Same last message — check if any block state changed (tool state, text content)
    const pBlocks = pLast.blocks || []
    const nBlocks = nLast.blocks || []
    if (pBlocks.length !== nBlocks.length) return true
    for (let i = 0; i < nBlocks.length; i++) {
      if (pBlocks[i].state !== nBlocks[i].state) return true
      if (pBlocks[i].text !== nBlocks[i].text) return true
      if (pBlocks[i].expanded !== nBlocks[i].expanded) return true
    }
    return false
  },

  onShareAppMessage() {
    const name = this._sessionName || 'CodePocket'
    const shareId = this._lastShareId
    const path = shareId ? `/pages/share-preview/share-preview?shareId=${shareId}` : '/pages/index/index'
    console.log('[chat] onShareAppMessage, _lastShareId:', shareId, 'path:', path)
    return {
      title: `${name} — CodePocket`,
      path,
      imageUrl: this.data.shareImagePath || '',
    }
  },

  onShareTimeline() {
    const shareId = this._lastShareId
    return {
      title: `${this._sessionName || 'CodePocket'} — CodePocket`,
      imageUrl: this.data.shareImagePath || '',
    }
  },

  onScroll(e) {
    const { scrollTop, scrollHeight, deltaY } = e.detail
    // deltaY > 0 means scrolling down, deltaY < 0 means scrolling up
    if (deltaY !== undefined && deltaY < -50) {
      this._isNearBottom = false
    }
    // If scrolled very close to bottom, re-enable auto-scroll
    const viewportHeight = this._viewportHeight
    if (viewportHeight && scrollTop + viewportHeight >= scrollHeight - 200) {
      this._isNearBottom = true
    }
    // Clear stale scrollToId so setData doesn't re-trigger it
    if (this.data.scrollToId && !this._isNearBottom) {
      this.setData({ scrollToId: '' })
    }
  },

  onLoad(options) {
    const sessionId = options.sessionId || ''
    this._sessionName = decodeURIComponent(options.name || '对话')
    this.setData({ sessionId })
    wx.setNavigationBarTitle({ title: this._sessionName })

    // Load wallpaper
    try {
      const wp = wx.getStorageSync('chat_wallpaper')
      if (wp) {
        if (wp.type === 'preset') this.setData({ wallpaperClass: wp.id })
        else if (wp.type === 'custom') this.setData({ wallpaperCustomPath: wp.path })
      }
    } catch {}

    // Load card mode
    this.setData({ cardMode: wx.getStorageSync('chat_card_style') === '1' })

    const relay = require('../../utils/relay')
    if (!relay.isConnected()) {
      if (!relay.autoConnect((msg) => this.onWsEvent(msg))) {
        wx.redirectTo({ url: '/pages/setup/setup' })
        return
      }
    } else {
      relay.autoConnect((msg) => this.onWsEvent(msg))
    }
    relay.onPhoneAction((msg) => this.onPhoneAction(msg))
    // Restore from cache first, then refresh in background
    this._restoreCache()
    this.loadMessages()

    // Measure scroll viewport height for near-bottom detection
    this._measureViewport()
  },

  onShow() {
    const relay = require('../../utils/relay')
    // Restore YOLO mode state
    const savedYolo = wx.getStorageSync(`yolo_${this.data.sessionId}`)
    if (savedYolo) this.setData({ yoloMode: true })

    // Restore unsent input text
    const savedInput = wx.getStorageSync(`draft_${this.data.sessionId}`)
    if (savedInput && !this.data.inputText) this.setData({ inputText: savedInput })

    // Prefill from toolbox guide
    const app = getApp()
    if (app.chatPrefill) {
      this.setData({ inputText: app.chatPrefill })
      delete app.chatPrefill
    }
    if (app.chatImage) {
      const path = app.chatImage
      delete app.chatImage
      readFileAsBase64(path).then((base64) => {
        this.setData({
          selectedImage: { path, base64, size: 0 },
        })
      }).catch(() => {})
    }

    relay.autoConnect((msg) => this.onWsEvent(msg))
    relay.onPhoneAction((msg) => this.onPhoneAction(msg))
    if (relay.isConnected()) this.loadMessages()
  },

  onHide() {
    const text = this.data.inputText
    const key = `draft_${this.data.sessionId}`
    if (text) wx.setStorageSync(key, text)
    else wx.removeStorageSync(key)
  },

  onUnload() {
    const text = this.data.inputText
    const key = `draft_${this.data.sessionId}`
    if (text) wx.setStorageSync(key, text)
    else wx.removeStorageSync(key)
    if (this._reloadTimer) { clearTimeout(this._reloadTimer); this._reloadTimer = null }
  },

  /**
   * Load all messages from the hub API, parse into structured blocks,
   * and pair tool_results with their tool-calls.
   */
  async loadMessages() {
    // Skip-if-busy: when the relay pipe is congested, a previous load may
    // still be in-flight (getMessages + getSessionDetail REST round-trips).
    // Piling another request on top just makes congestion worse and triggers
    // 60s Request timeouts. Instead mark needs-reload and re-run once on
    // completion.
    if (this._loadingMessages) {
      this._needsReload = true
      return
    }
    this._loadingMessages = true
    const relay = require('../../utils/relay')
    try {
      const data = await relay.getMessages(this.data.sessionId)
      const raw = data.messages || []
      this._hasMoreMessages = !!data.page?.hasMore
      this._nextBeforeSeq = data.page?.nextBeforeSeq || null
      // Reset tool-call tracking before batch parse
      parser.reset()

      // Parse all messages in order (oldest first)
      const messages = raw.map(m => parser.parseMessage(m)).filter(Boolean)

      // Merge consecutive tool-call-only messages into tool-groups,
      // preserving expanded state from current rendered messages
      const prevState = parser.captureExpandState(this.data.messages)
      const merged = parser.mergeToolCallMessages(messages, prevState)

      // Detect queued messages (user messages with invokedAt === null)
      let queuedCount = 0
      for (const m of raw) {
        const unwrapped = unwrapEnvelope(m)
        if (unwrapped && unwrapped.role === 'user' && m.invokedAt === null && m.status !== 'failed') {
          queuedCount++
        }
      }

      // Fetch pending permissions + remote state from session detail
      let remoteControlled = false
      let sessionDetail = null
      try {
        sessionDetail = await relay.getSessionDetail(this.data.sessionId)
        const agentState = sessionDetail.session?.agentState || {}
        const requests = agentState.requests || {}
        const pendingKeys = Object.keys(requests)
        remoteControlled = !!agentState.controlledByUser

        if (pendingKeys.length > 0) {
          // Auto-approve if YOLO mode is on
          if (this.data.yoloMode) {
            for (const reqId of pendingKeys) {
              try { await relay.approvePermission(this.data.sessionId, reqId) } catch {}
            }
            // Reload after auto-approving
            setTimeout(() => this.loadMessages(), 500)
            return
          }

          const permBlocks = pendingKeys.map(reqId => {
            const req = requests[reqId]
            return {
              type: 'permission',
              requestId: reqId,
              tool: req.tool || '',
              input: typeof req.arguments === 'string' ? req.arguments : JSON.stringify(req.arguments || ''),
              questions: [],
              selectedAnswers: {},
            }
          })
          merged.push({
            id: 'pending-perms',
            role: 'agent',
            timeStr: '',
            blocks: permBlocks,
          })
        }
      } catch {}

      // Skip update if messages haven't actually changed
      const prevLen = this.data.messages.length
      const newLen = merged.length
      const changed = newLen !== prevLen || (newLen > 0 && this._messagesChanged(this.data.messages, merged))

      // When server returns empty but we have cached messages (e.g. resumed session),
      // don't wipe them out — the new session hasn't synced messages yet
      if (newLen === 0 && prevLen > 0) {
        // Still update remoteControlled/queuedCount if changed
        if (remoteControlled !== this.data.remoteControlled || queuedCount !== this.data.queuedCount) {
          this.setData({ remoteControlled, queuedCount })
        }
      } else if (changed || remoteControlled !== this.data.remoteControlled || queuedCount !== this.data.queuedCount) {
        this.setData({ messages: merged, remoteControlled, queuedCount })
        this._saveCache(merged)
      }
      if (this._isNearBottom) {
        this.scrollToBottom()
      }

      // Detect if agent is still actively processing
      if (!this.data.aborting && !this._aborted) {
        // Prefer Hub's authoritative thinking state when available
        const hubThinking = sessionDetail?.session?.thinking
        let isActive = (hubThinking != null) ? !!hubThinking : undefined // undefined = unknown, fall back to heuristic

        if (isActive === undefined) {
          isActive = false
          // Last message is user with no agent response → agent is thinking
          const lastMsg = merged[merged.length - 1]
          if (lastMsg && lastMsg.role === 'user') {
            isActive = true
          }
          // Check for running tool calls
          if (!isActive) {
            for (const m of merged) {
              if (!m.blocks) continue
              for (const b of m.blocks) {
                if (b.type === 'tool-call' && b.state === 'running') { isActive = true; break }
              }
              if (isActive) break
            }
          }
        }

        if (isActive && !this.data.thinking) {
          this.setData({ thinking: true, thinkingSeconds: 0 })
          this.startThinkingTimer()
        } else if (!isActive && this.data.thinking) {
          this.stopThinkingTimer()
          this.setData({ thinking: false })
        }
      }
    } catch (e) {
      console.error('[chat] loadMessages failed', e)
    } finally {
      this._loadingMessages = false
      if (this._needsReload) {
        this._needsReload = false
        setTimeout(() => this.loadMessages(), 100)
      }
    }
  },

  async loadMoreMessages() {
    if (this._loadingMore || !this._hasMoreMessages || !this._nextBeforeSeq) return
    this._loadingMore = true
    this.setData({ loadingMore: true })

    const relay = require('../../utils/relay')
    try {
      const data = await relay.getMessages(this.data.sessionId, { beforeSeq: this._nextBeforeSeq })
      const raw = data.messages || []
      if (raw.length === 0) {
        this._hasMoreMessages = false
        this.setData({ loadingMore: false })
        this._loadingMore = false
        return
      }

      this._hasMoreMessages = !!data.page?.hasMore
      this._nextBeforeSeq = data.page?.nextBeforeSeq || null

      parser.reset()
      const olderMessages = raw.map(m => parser.parseMessage(m)).filter(Boolean)

      // Merge with existing messages: older ones first, then current
      const allRaw = olderMessages
      const prevState = parser.captureExpandState(this.data.messages)
      const merged = parser.mergeToolCallMessages(allRaw, prevState)

      // Append current messages (re-parsed with fresh parser state)
      const currentParsed = this.data.messages.map(m => ({ ...m }))
      const finalMessages = [...merged, ...currentParsed]

      this.setData({ messages: finalMessages, loadingMore: false })
    } catch (e) {
      console.error('[chat] loadMoreMessages failed', e)
      this.setData({ loadingMore: false })
    }
    this._loadingMore = false
  },

  // ── Message cache ──

  _cacheKey() {
    return `msg_cache_${this.data.sessionId}`
  },

  _restoreCache() {
    try {
      const cached = wx.getStorageSync(this._cacheKey())
      if (cached && cached.messages && cached.messages.length > 0) {
        this._hasMoreMessages = cached.hasMore || false
        this._nextBeforeSeq = cached.nextBeforeSeq || null
        this.setData({ messages: cached.messages })
        this.scrollToBottom()
      }
    } catch {}
  },

  _saveCache(messages) {
    try {
      wx.setStorageSync(this._cacheKey(), {
        messages,
        hasMore: this._hasMoreMessages,
        nextBeforeSeq: this._nextBeforeSeq,
        savedAt: Date.now(),
      })
    } catch {}
  },

  // ── WebSocket events ──

  onWsEvent(msg) {
    if (msg.type !== 'sse-event' || !msg.event) return
    const evt = msg.event

    // Only reload for events related to current session
    const sid = this.data.sessionId
    if (evt.sessionId && evt.sessionId !== sid) return

    if (evt.type === 'compact') {
      const p = evt.progress || evt.percent
      if (p !== undefined) {
        this.setData({ compacting: true, compactProgress: Math.round(p) })
      } else {
        this.setData({ compacting: true })
      }
    } else if (evt.type === 'message-received' || evt.type === 'messages' ||
        evt.type === 'message' || evt.type === 'messages-consumed' ||
        evt.type === 'messages-invalidated' || evt.type === 'session-updated') {
      // Debounce: hub bursts 2-4 message-received events per reply,
      // collapse rapid events into a single loadMessages() call.
      // 1000ms absorbs full burst without starving (events arrive every 500ms+)
      if (this._reloadTimer) clearTimeout(this._reloadTimer)
      this._reloadTimer = setTimeout(() => {
        this._reloadTimer = null
        this.loadMessages()
      }, 1000)
      this.setData({ compacting: false, compactProgress: 0 })
    }
  },

  // ── Input handling ──

  onInput(e) {
    this.setData({ inputText: e.detail.value })
  },

  /**
   * Send a text message (with optional image attachment).
   */
  async onSend() {
    const text = this.data.inputText.trim()
    const selectedImage = this.data.selectedImage // capture before clearing
    if ((!text && !selectedImage) || this.data.sending) return

    const relay = require('../../utils/relay')
    const displayText = text || '(image)'
    const userMsg = {
      id: `local_${Date.now()}`,
      role: 'user',
      text: displayText,
      timeStr: formatTime(Date.now()),
      blocks: [{
        type: 'text',
        text: displayText,
        segments: [],
      }],
      attachments: selectedImage ? [{ type: 'image', previewUrl: selectedImage.path }] : [],
    }

    this.setData({
      sending: true,
      inputText: '',
      selectedImage: null,
      messages: [...this.data.messages, userMsg],
      thinking: true,
      aborting: false,
      thinkingSeconds: 0,
    })
    this._aborted = false
    this.startThinkingTimer()
    wx.removeStorageSync(`draft_${this.data.sessionId}`)
    this.scrollToBottom()

    // Build send text with optional persona prompt
    const { getSelectedPersona, buildPersonaPrompt } = require('../../utils/personas')
    const persona = getSelectedPersona()
    const personaPrefix = buildPersonaPrompt(persona)
    const sendText = personaPrefix ? `${personaPrefix}${text}` : text

    try {
      let attachments = []
      if (selectedImage) {
        // Upload image and attach to message
        const filename = `image_${Date.now()}.png`
        const uploadRes = await relay.uploadFile(this.data.sessionId, filename, selectedImage.base64, 'image/png')
        attachments.push({
          id: `att_${Date.now()}`,
          filename,
          mimeType: 'image/png',
          size: selectedImage.size || 0,
          path: uploadRes?.path || '',
        })
      }
      await relay.sendMessage(this.data.sessionId, sendText, attachments)
      this.setData({ sending: false })
    } catch (err) {
      console.error('[chat] send failed', err)
      this.setData({ sending: false, thinking: false })
      wx.showModal({
        title: '发送失败',
        content: '请确认终端已启动该对话（codepocket）',
        confirmText: '启动对话',
        cancelText: '关闭',
        success: (res) => {
          if (res.confirm) {
            wx.switchTab({ url: '/pages/index/index' })
          }
        },
      })
    }
  },

  onToggleYolo() {
    const newMode = !this.data.yoloMode
    this.setData({ yoloMode: newMode })
    wx.setStorageSync(`yolo_${this.data.sessionId}`, newMode ? '1' : '')
    const relay = require('../../utils/relay')
    relay.setPermissionMode(this.data.sessionId, newMode ? 'bypassPermissions' : 'default').catch(() => {})
    if (newMode) this.loadMessages() // trigger auto-approve for any pending
    wx.showToast({ title: newMode ? 'YOLO 模式已开启' : '已恢复默认模式', icon: 'none' })
  },

  // ── Tool-call interactions ──

  /**
   * Toggle expanded state on a tool-call block.
   * Dataset: msgIdx, blockIdx
   */
  onToggleTool(e) {
    const { msgIdx, blockIdx } = e.currentTarget.dataset
    const msgIdxNum = parseInt(msgIdx, 10)
    const blockIdxNum = parseInt(blockIdx, 10)
    const messages = this.data.messages
    const msg = messages[msgIdxNum]
    if (!msg || !msg.blocks || !msg.blocks[blockIdxNum]) return

    const key = `messages[${msgIdxNum}].blocks[${blockIdxNum}].expanded`
    this.setData({ [key]: !msg.blocks[blockIdxNum].expanded })
  },

  async onPreviewFile(e) {
    const { msgIdx, blockIdx } = e.currentTarget.dataset
    const mi = parseInt(msgIdx, 10)
    const bi = parseInt(blockIdx, 10)
    const block = this.data.messages[mi]?.blocks?.[bi]
    const filePath = block?.previewFilePath || e.currentTarget.dataset.filePath
    if (!filePath) {
      wx.showToast({ title: '未找到文件路径', icon: 'none' })
      return
    }

    wx.showLoading({ title: '加载文件...' })

    try {
      const relay = require('../../utils/relay')
      const res = await relay.readFile(this.data.sessionId, filePath)
      wx.hideLoading()

      if (!res || !res.success || !res.data || !res.data.content) {
        wx.showToast({ title: (res && res.error) || '文件读取失败', icon: 'none' })
        return
      }

      const { filename, content } = res.data
      const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : ''
      const fs = wx.getFileSystemManager()
      const tempPath = `${wx.env.USER_DATA_PATH}/${Date.now()}_${filename}`
      const binary = wx.base64ToArrayBuffer(content)
      fs.writeFileSync(tempPath, binary)

      if (isImageExt(ext)) {
        wx.previewImage({ urls: [tempPath], current: tempPath })
      } else {
        wx.openDocument({
          filePath: tempPath,
          fileType: ext || undefined,
          success: () => {},
          fail: (err) => {
            console.error('[chat] openDocument failed', err)
            wx.showToast({ title: '无法打开文件', icon: 'none' })
          }
        })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('[chat] preview file failed', err)
      wx.showToast({ title: '文件加载失败', icon: 'none' })
    }
  },

  /**
   * Approve a permission request.
   * Dataset: requestId
   */
  onApprove(e) {
    const { requestId } = e.currentTarget.dataset
    if (!requestId) return
    const relay = require('../../utils/relay')
    relay.approvePermission(this.data.sessionId, requestId)
      .then(() => wx.showToast({ title: '已允许', icon: 'success' }))
      .catch(() => wx.showToast({ title: '操作失败', icon: 'none' }))
  },

  /**
   * Deny a permission request.
   * Dataset: requestId
   */
  onDeny(e) {
    const { requestId } = e.currentTarget.dataset
    if (!requestId) return
    const relay = require('../../utils/relay')
    relay.denyPermission(this.data.sessionId, requestId)
      .then(() => wx.showToast({ title: '已拒绝', icon: 'none' }))
      .catch(() => wx.showToast({ title: '操作失败', icon: 'none' }))
  },

  /**
   * Select an option for a multi-choice question in AskUserQuestion.
   * Dataset: requestId, questionIdx, optionLabel
   */
  onSelectOption(e) {
    const { questionIdx, optionLabel } = e.currentTarget.dataset
    if (questionIdx === undefined || !optionLabel) return

    const qi = parseInt(questionIdx, 10)
    const { msgIdx, blockIdx } = e.currentTarget.dataset
    const mi = parseInt(msgIdx, 10)
    const bi = parseInt(blockIdx, 10)
    const messages = this.data.messages
    const msg = messages[mi]
    if (!msg || !msg.blocks || !msg.blocks[bi]) return
    const block = msg.blocks[bi]
    if (block.type !== 'permission') return

    const key = `messages[${mi}].blocks[${bi}].selectedAnswers`
    const updated = { ...block.selectedAnswers }
    updated[qi] = optionLabel
    this.setData({ [key]: updated })
  },

  /**
   * Submit answers for an AskUserQuestion permission block.
   * Dataset: requestId
   */
  async onSubmitAnswers(e) {
    const { msgIdx, blockIdx, requestId: dsRequestId } = e.currentTarget.dataset
    const mi = parseInt(msgIdx, 10)
    const bi = parseInt(blockIdx, 10)
    const messages = this.data.messages
    const msg = messages[mi]
    if (!msg || !msg.blocks || !msg.blocks[bi]) return
    const block = msg.blocks[bi]
    if (block.type !== 'permission') return

    const answers = block.selectedAnswers || {}
    const requestId = dsRequestId || block.requestId || null
    const relay = require('../../utils/relay')

    if (requestId) {
      // Hub permission request — approve with answers
      relay.approvePermission(this.data.sessionId, requestId, { answers })
        .then(() => wx.showToast({ title: '已提交', icon: 'success' }))
        .catch(() => wx.showToast({ title: '提交失败', icon: 'none' }))
    } else {
      // AskUserQuestion from SSE — send answer as user message
      const parts = []
      const questions = block.questions || []
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i]
        const label = answers[i] || ''
        if (questions.length === 1) {
          parts.push(label)
        } else {
          parts.push(`${q.header || 'Q' + (i + 1)}: ${label}`)
        }
      }
      const answerText = parts.join('\n')

      // Mark as submitted so loadMessages won't recreate the block
      if (block.toolId) parser.markQuestionSubmitted(block.toolId)

      // Remove the permission block from display
      const newBlocks = msg.blocks.filter((_, idx) => idx !== bi)
      this.setData({
        messages: messages.map((m, idx) => idx === mi ? { ...m, blocks: newBlocks } : m),
      })

      relay.sendMessage(this.data.sessionId, answerText)
        .then(() => wx.showToast({ title: '已提交', icon: 'success' }))
        .catch(() => wx.showToast({ title: '提交失败', icon: 'none' }))
    }
  },

  /**
   * Toggle a tool-group's expanded state.
   */
  onToggleToolGroup(e) {
    const { msgIdx, blockIdx } = e.currentTarget.dataset
    const mi = parseInt(msgIdx, 10)
    const bi = parseInt(blockIdx, 10)
    const block = this.data.messages[mi]?.blocks?.[bi]
    if (!block || block.type !== 'tool-group') return
    const key = `messages[${mi}].blocks[${bi}].expanded`
    this.setData({ [key]: !block.expanded })
  },

  /**
   * Toggle an individual tool's expanded state within a tool-group.
   */
  onToggleToolInGroup(e) {
    const { msgIdx, blockIdx, toolIdx } = e.currentTarget.dataset
    const mi = parseInt(msgIdx, 10)
    const bi = parseInt(blockIdx, 10)
    const ti = parseInt(toolIdx, 10)
    const block = this.data.messages[mi]?.blocks?.[bi]
    if (!block || block.type !== 'tool-group') return
    const tool = block.tools[ti]
    if (!tool) return
    const key = `messages[${mi}].blocks[${bi}].tools[${ti}].expanded`
    this.setData({ [key]: !tool.expanded })
  },

  /**
   * Toggle collapsible result for a tool-call (single or in-group).
   */
  onToggleResultCollapse(e) {
    const { msgIdx, blockIdx, toolIdx } = e.currentTarget.dataset
    const mi = parseInt(msgIdx, 10)
    const bi = parseInt(blockIdx, 10)
    const block = this.data.messages[mi]?.blocks?.[bi]
    if (!block) return

    if (block.type === 'tool-group') {
      const ti = parseInt(toolIdx, 10)
      const tool = block.tools[ti]
      if (!tool) return
      const key = `messages[${mi}].blocks[${bi}].tools[${ti}].resultExpanded`
      this.setData({ [key]: !tool.resultExpanded })
    } else if (block.type === 'tool-call') {
      const key = `messages[${mi}].blocks[${bi}].resultExpanded`
      this.setData({ [key]: !block.resultExpanded })
    }
  },

  /**
   * Copy message text to clipboard.
   */
  onCopyMessage(e) {
    const { msgIdx, blockIdx } = e.currentTarget.dataset
    const mi = parseInt(msgIdx, 10)
    const bi = parseInt(blockIdx, 10)
    const block = this.data.messages[mi]?.blocks?.[bi]
    if (!block) return
    const text = block.text || block.resultDisplay || ''
    if (!text) return
    wx.setClipboardData({ data: text, showToast: true })
  },

  /**
   * Toggle timestamp visibility for a message.
   */
  onToggleMsgTime(e) {
    const idx = parseInt(e.currentTarget.dataset.msgIdx, 10)
    this.setData({
      visibleTimeIdx: this.data.visibleTimeIdx === idx ? -1 : idx,
    })
  },

  /**
   * Toggle thinking block collapse in messages.
   */
  onToggleThinking(e) {
    const { msgIdx, blockIdx } = e.currentTarget.dataset
    const mi = parseInt(msgIdx, 10)
    const bi = parseInt(blockIdx, 10)
    const block = this.data.messages[mi]?.blocks?.[bi]
    if (!block || block.type !== 'thinking') return
    const key = `messages[${mi}].blocks[${bi}].collapsed`
    this.setData({ [key]: !block.collapsed })
  },

  // ── Thinking timer ──

  startThinkingTimer(resetCounter = true) {
    if (resetCounter || !this._thinkingStartTime) {
      this._thinkingStartTime = Date.now()
    }
    if (this._thinkingTimer) return
    this._thinkingTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this._thinkingStartTime) / 1000)
      this.setData({ thinkingSeconds: elapsed })
    }, 1000)
  },

  stopThinkingTimer() {
    if (this._thinkingTimer) {
      clearInterval(this._thinkingTimer)
      this._thinkingTimer = null
    }
  },

  // ── Session control ──

  /**
   * Abort the current session / running task.
   */
  onAbort() {
    if (this.data.aborting) return
    this.setData({ aborting: true })
    this._aborted = true
    const relay = require('../../utils/relay')
    relay.abortSession(this.data.sessionId)
      .then(async () => {
        this.stopThinkingTimer()
        this.setData({ aborting: false, thinking: false })
        wx.showToast({ title: '已中断', icon: 'none' })
        await this.loadMessages()
      })
      .catch(() => {
        this.stopThinkingTimer()
        this.setData({ aborting: false, thinking: false })
      })
  },

  // ── Image attachment ──

  /**
   * Choose an image from the device to attach to the next message.
   */
  async onChooseImage() {
    this.setData({ showActionMenu: false })
    const relay = require('../../utils/relay')
    try { await relay.ensurePrivacyAuthorize() } catch { return }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles[0]
        if (!file) return
        readFileAsBase64(file.tempFilePath).then((base64) => {
          this.setData({
            selectedImage: {
              path: file.tempFilePath,
              base64,
              size: file.size,
            },
          })
        }).catch((err) => {
          console.error('Failed to read image file', err)
          wx.showToast({ title: '图片读取失败', icon: 'none' })
        })
      },
    })
  },

  /**
   * Remove the currently selected image attachment.
   */
  onRemoveImage() {
    this.setData({ selectedImage: null })
  },

  // ── Quick commands ──

  onToggleActionMenu() {
    this.setData({ showActionMenu: !this.data.showActionMenu })
  },

  onShowShortcuts() {
    try {
      const list = wx.getStorageSync('quick_commands') || []
      this.setData({ shortcutList: list, showShortcutPopup: true, showActionMenu: false, editingShortcut: null, editingIndex: -1 })
    } catch {
      this.setData({ shortcutList: [], showShortcutPopup: true, showActionMenu: false, editingShortcut: null, editingIndex: -1 })
    }
  },

  onCloseShortcuts() {
    this.setData({ showShortcutPopup: false, editingShortcut: null, editingIndex: -1 })
  },

  onUseShortcut(e) {
    const idx = e.currentTarget.dataset.index
    const text = this.data.shortcutList[idx].text
    this.setData({ showShortcutPopup: false, inputText: text })
  },

  onAddShortcut() {
    this.setData({ editingShortcut: { name: '', text: '' }, editingIndex: -1 })
  },

  onEditShortcut(e) {
    const idx = e.currentTarget.dataset.index
    const item = this.data.shortcutList[idx]
    this.setData({ editingShortcut: { name: item.name, text: item.text }, editingIndex: idx })
  },

  onDeleteShortcut(e) {
    const idx = e.currentTarget.dataset.index
    const list = this.data.shortcutList
    list.splice(idx, 1)
    wx.setStorageSync('quick_commands', list)
    this.setData({ shortcutList: list })
    wx.showToast({ title: '已删除', icon: 'none' })
  },

  onSaveShortcut() {
    const { name, text } = this.data.editingShortcut
    if (!text.trim()) {
      wx.showToast({ title: '请输入指令内容', icon: 'none' })
      return
    }
    const list = this.data.shortcutList
    const entry = { name: name.trim() || text.trim().slice(0, 10), text: text.trim() }
    if (this.data.editingIndex === -1) {
      list.push(entry)
    } else {
      list[this.data.editingIndex] = entry
    }
    wx.setStorageSync('quick_commands', list)
    this.setData({ shortcutList: list, editingShortcut: null, editingIndex: -1 })
    wx.showToast({ title: '已保存', icon: 'none' })
  },

  onCancelEditShortcut() {
    this.setData({ editingShortcut: null, editingIndex: -1 })
  },

  onShortcutInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`editingShortcut.${field}`]: e.detail.value })
  },

  onPreviewImage(e) {
    const { url } = e.currentTarget.dataset
    if (url) {
      wx.previewImage({ urls: [url], current: url })
    }
  },

  // ── Phone action handling ──

  onPhoneAction(msg) {
    const { actionId, tool, params } = msg
    // Query tools don't need confirmation
    if (tool === 'phone_todo_list' || tool === 'phone_calendar_query') {
      this.executePhoneAction(actionId, tool, params)
      return
    }
    // Other tools need custom modal to provide user interaction context
    // (wx APIs like addPhoneCalendar/getLocation require tap event context)
    this.setData({
      phoneModal: { visible: true, actionId, tool, params: params || {} },
    })
  },

  onPhoneActionConfirm(e) {
    const { actionId, tool, params } = e.detail
    this.setData({ 'phoneModal.visible': false })
    this.executePhoneAction(actionId, tool, params)
  },

  onPhoneActionCancel(e) {
    const { actionId } = e.detail
    const relay = require('../../utils/relay')
    relay.sendPhoneActionResponse(actionId, false, null, '用户取消了操作')
    this.setData({ phoneModal: { visible: false, actionId: '', tool: '', params: {} } })
  },

  async executePhoneAction(actionId, tool, params) {
    const relay = require('../../utils/relay')
    try {
      let result = null

      if (tool === 'phone_calendar_add') {
        await new Promise((resolve, reject) => {
          wx.addPhoneCalendar({
            title: params.title || '',
            startTime: params.startTime ? new Date(params.startTime).getTime() / 1000 : Date.now() / 1000,
            endTime: params.endTime ? new Date(params.endTime).getTime() / 1000 : undefined,
            description: params.description || '',
            alarmOffset: params.reminderAlarm || 0,
            success: resolve,
            fail: reject,
          })
        })
        result = { success: true, message: '日程已添加' }

      } else if (tool === 'phone_todo_add') {
        const todos = wx.getStorageSync('codepocket_todos') || []
        const todo = {
          id: `todo_${Date.now()}`,
          title: params.title,
          dueDate: params.dueDate || null,
          priority: params.priority || 'medium',
          completed: false,
          createdAt: Date.now(),
        }
        todos.push(todo)
        wx.setStorageSync('codepocket_todos', todos)
        result = { success: true, todoId: todo.id, message: '待办已添加' }

      } else if (tool === 'phone_todo_complete') {
        const todos = wx.getStorageSync('codepocket_todos') || []
        const idx = todos.findIndex((t) => t.id === params.todoId)
        if (idx >= 0) {
          todos[idx].completed = true
          wx.setStorageSync('codepocket_todos', todos)
          result = { success: true, message: '待办已完成' }
        } else {
          result = { success: false, error: '找不到该待办' }
        }

      } else if (tool === 'phone_todo_list') {
        const todos = wx.getStorageSync('codepocket_todos') || []
        const filter = params.filter || 'pending'
        const filtered = filter === 'all' ? todos : todos.filter((t) => filter === 'completed' ? t.completed : !t.completed)
        result = { success: true, todos: filtered }

      } else if (tool === 'phone_location_get') {
        result = { success: false, error: '定位接口暂无权限，请在微信公众平台申请后使用' }

      } else if (tool === 'phone_location_track') {
        result = { success: false, error: '定位接口暂无权限，请在微信公众平台申请后使用' }

      } else if (tool === 'phone_map_show') {
        // Store params for map page, then navigate
        wx.setStorageSync('mapShowData', {
          markers: params.markers || [],
          polyline: params.polyline || [],
          title: params.title || '地图',
          actionId,
        })
        wx.navigateTo({ url: '/pages/map/map' })
        // Response will be sent by map page when user taps "完成"
        return

      } else if (tool === 'phone_notification_send') {
        wx.showToast({ title: params.title, icon: 'none', duration: 3000 })
        result = { success: true, message: '通知已显示' }

      } else if (tool === 'phone_clipboard_write') {
        wx.setClipboardData({ data: params.text || '' })
        result = { success: true, message: '已复制到剪贴板' }

      } else if (tool === 'phone_location_stop') {
        result = { success: false, error: '定位接口暂无权限，请在微信公众平台申请后使用' }

      } else {
        result = { success: false, error: `未知工具: ${tool}` }
      }

      relay.sendPhoneActionResponse(actionId, true, result, null)

    } catch (err) {
      console.error('[phone-action] execute failed:', err)
      relay.sendPhoneActionResponse(actionId, false, null, err.errMsg || err.message || '执行失败')
    }
  },

  // ── Helpers ──

  _measureViewport() {
    wx.createSelectorQuery()
      .select('.chat-messages')
      .boundingClientRect((rect) => {
        if (rect) this._viewportHeight = rect.height
      })
      .exec()
  },

  scrollToBottom() {
    setTimeout(() => {
      const id = `msg-${this.data.messages.length - 1}`
      this.setData({ scrollToId: id })
      // Clear after scroll completes so it doesn't stick around
      setTimeout(() => {
        if (this.data.scrollToId === id) {
          this.setData({ scrollToId: '' })
        }
      }, 300)
    }, 50)
  },

  _updateSelection(ids) {
    const updates = { selectedIds: ids }
    this.data.messages.forEach((m, i) => {
      updates[`messages[${i}]._selected`] = ids.indexOf(m.id) >= 0
    })
    this.setData(updates)
  },

  onLongPressMessage(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    this.setData({ selecting: true, showActionMenu: false })
    this._updateSelection([id])
  },

  onTapMessage(e) {
    if (!this.data.selecting) return
    const id = e.currentTarget.dataset.id
    if (!id) return
    const ids = this.data.selectedIds.slice()
    const idx = ids.indexOf(id)
    if (idx >= 0) {
      ids.splice(idx, 1)
    } else {
      ids.push(id)
    }
    this._updateSelection(ids)
  },

  onSelectAll() {
    const ids = this.data.messages.map(m => m.id).filter(Boolean)
    this._updateSelection(ids)
  },

  onCancelSelect() {
    const updates = { selecting: false, selectedIds: [] }
    this.data.messages.forEach((m, i) => {
      updates[`messages[${i}]._selected`] = false
    })
    this.setData(updates)
  },

  async onShareSelected() {
    if (this.data.selectedIds.length === 0) {
      wx.showToast({ title: '请先选择消息', icon: 'none' })
      return
    }
    const selected = this.data.messages.filter(m => m._selected)
    // Clear selection
    const updates = { selecting: false, selectedIds: [] }
    this.data.messages.forEach((m, i) => {
      updates[`messages[${i}]._selected`] = false
    })
    this.setData(updates)

    wx.showLoading({ title: '准备分享...' })
    try {
      const relay = require('../../utils/relay')
      const res = await relay.uploadShare({
        name: this._sessionName || '对话',
        agent: 'Claude',
        messages: selected,
      })
      wx.hideLoading()
      this._lastShareId = res.id
      console.log('[chat] share uploaded, shareId:', res.id)
      wx.navigateTo({ url: `/pages/share-preview/share-preview?shareId=${res.id}` })
    } catch (e) {
      wx.hideLoading()
      console.error('[chat] share upload failed', e)
      wx.showModal({
        title: '分享失败',
        content: '上传对话失败，请检查网络连接或COS配置。只能保存图片到相册。',
        showCancel: true,
        cancelText: '取消',
        confirmText: '保存图片',
        success: (r) => {
          if (r.confirm) {
            const payload = { name: this._sessionName || '对话', path: '', agent: 'Claude', messages: selected }
            wx.setStorageSync('share_messages', payload)
            wx.navigateTo({ url: '/pages/share-preview/share-preview' })
          }
        },
      })
    }
  },

  _doExport(messages) {
    if (this._exporting) return
    this._exporting = true

    const query = wx.createSelectorQuery()
    query.select('#exportCanvas').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0]) {
        this._exporting = false
        return
      }
      const canvas = res[0].node
      let wallpaper = ''
      try {
        const wp = wx.getStorageSync('chat_wallpaper')
        if (wp && wp.type === 'preset') wallpaper = wp.id
      } catch {}
      const config = { width: 750, wallpaper, cardMode: this.data.cardMode, maxMsgPerSession: 30, maxTextLen: 500 }
      try {
        const { layoutAndPaint } = require('../../utils/canvas-renderer')
        layoutAndPaint([{ name: this._sessionName || '对话', path: '', agent: 'Claude', messages }], canvas, config)
      } catch (e) {
        this._exporting = false
        console.error('[chat] export render failed', e)
        wx.showToast({ title: '渲染失败', icon: 'none' })
        return
      }
      setTimeout(() => {
        const relay = require('../../utils/relay')
        wx.canvasToTempFilePath({
          canvas,
          success: async (imgRes) => {
            this._exporting = false
            try { await relay.ensurePrivacyAuthorize() } catch { return }
            wx.saveImageToPhotosAlbum({
              filePath: imgRes.tempFilePath,
              success: () => {
                wx.showModal({ title: '已保存到相册', content: '可以去微信发图给朋友分享', showCancel: false, confirmText: '好的' })
              },
              fail: (err) => {
                if (err.errMsg && err.errMsg.indexOf('auth deny') >= 0) {
                  wx.showModal({
                    title: '需要相册权限', content: '请在设置中允许访问相册', confirmText: '去设置',
                    success: (r) => { if (r.confirm) wx.openSetting() },
                  })
                } else {
                  wx.showToast({ title: '保存失败', icon: 'none' })
                }
              },
            })
          },
          fail: () => {
            this._exporting = false
            wx.showToast({ title: '导出失败', icon: 'none' })
          },
        })
      }, 300)
    })
  },

  // ── Share chat (enter selection mode) ──

  onNoop() {},

  onExportChat() {
    const msgs = this.data.messages || []
    if (msgs.length === 0) {
      wx.showToast({ title: '没有消息可分享', icon: 'none' })
      return
    }
    this.setData({ showActionMenu: false, selecting: true, selectedIds: [] })
  },
})
