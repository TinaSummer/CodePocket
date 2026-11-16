const MOCK = false

function formatRelative(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}

function mapSession(s) {
  const meta = s.metadata || {}
  return {
    id: s.id || '',
    name: meta.name || (meta.summary && meta.summary.text) || meta.path || s.id,
    path: meta.path || '',
    agent: meta.flavor || s.model || 'claude',
    active: !!s.active,
    thinking: !!s.thinking,
    summary: (meta.summary && meta.summary.text) || '',
    pendingCount: s.pendingRequestsCount || 0,
    timeStr: formatRelative(s.updatedAt || s.activeAt),
  }
}

Page({
  data: {
    sessions: [],
    loading: false,
    hubOffline: false,
    editing: false,
    selectedIds: [],
    showNewSession: false,
    newSessionDir: '',
    spawning: false,
    dirEntries: [],
    dirLoading: false,
    dirError: '',
  },

  onShareAppMessage() {
    return {
      title: 'CodePocket — 用手机控制 Claude Code',
      path: '/pages/index/index',
    }
  },

  onShareTimeline() {
    return {
      title: 'CodePocket — 用手机控制 Claude Code',
    }
  },

  onLoad() {
    if (MOCK) {
      this.setData({
        sessions: [
          { id: 's1', name: '重构认证模块', path: '~/work/codepocket', agent: 'claude', active: true, thinking: false, summary: '正在将 JWT 认证迁移到 session-based 方案', pendingCount: 1, timeStr: '刚刚' },
          { id: 's2', name: '修复支付回调', path: '~/work/shop-api', agent: 'claude', active: false, thinking: false, summary: 'Webhook 签名验证失败', pendingCount: 0, timeStr: '2 小时前' },
        ]
      })
    } else {
      const key = wx.getStorageSync('relay_key')
      if (!key) {
        wx.redirectTo({ url: '/pages/setup/setup' })
        return
      }
      this._restoreCache()
      this.loadSessions()
    }
  },

  // ── Sessions cache (same stale-while-revalidate pattern as chat's msg_cache) ──

  _restoreCache() {
    try {
      const cached = wx.getStorageSync('sessions_cache')
      if (cached && Array.isArray(cached.sessions) && cached.sessions.length > 0) {
        this.setData({ sessions: cached.sessions, loading: false })
      }
    } catch {}
  },

  _saveCache(sessions) {
    try {
      wx.setStorageSync('sessions_cache', { sessions, savedAt: Date.now() })
    } catch {}
  },

  async loadSessions() {
    const relay = require('../../utils/relay')
    // Cold start: WS not ready yet. Don't bounce to setup — cached list is
    // already rendered; the background pair triggers reload via onWsEvent.
    if (!relay.isReady()) {
      relay.autoConnect((msg) => this.onWsEvent(msg))
      if (!this.data.sessions.length) this.setData({ loading: true })
      return
    }
    // Keep showing cached content instead of flashing a spinner over it
    this.setData({ loading: this.data.sessions.length === 0, hubOffline: false })
    try {
      const data = await relay.getSessions()
      const raw = data.sessions || []
      const sessions = raw.map(s => {
        const mapped = mapSession(s)
        mapped._selected = this.data.editing && this.data.selectedIds.indexOf(mapped.id) >= 0
        return mapped
      })
      this.setData({ sessions, loading: false })
      this._saveCache(sessions)
      this._cleanMessageCaches(raw)
    } catch (e) {
      console.error('loadSessions failed', e)
      const msg = e.message || ''
      if (msg.indexOf('Hub offline') >= 0) {
        this.setData({ loading: false, hubOffline: true })
      } else {
        this.setData({ loading: false })
        if (msg.indexOf('Invalid token') >= 0 || msg.indexOf('Unauthorized') >= 0) {
          wx.redirectTo({ url: '/pages/setup/setup' })
        }
      }
    }
  },

  onShow() {
    if (!MOCK) {
      // Redirect only when there's genuinely no key (never paired / revoked);
      // a not-yet-ready socket is a normal cold-start state, not a setup need.
      if (!wx.getStorageSync('relay_key')) {
        wx.redirectTo({ url: '/pages/setup/setup' })
        return
      }
      this.loadSessions()
    }
  },

  onWsEvent(msg) {
    // Background pair just completed (cold start) — fetch now.
    if (msg.type === 'paired') {
      this.loadSessions()
      return
    }
    if (msg.type === 'pair-error') {
      // Computer not connected / throttled — show the offline hint instead
      // of an endless spinner over an empty list.
      if (msg.code === 'hub_offline' || msg.code === 'rate_limited') {
        this.setData({ loading: false, hubOffline: true })
      }
      // Key revoked (relay.js already cleared it) — setup re-registers.
      if (msg.code === 'invalid_key') {
        wx.redirectTo({ url: '/pages/setup/setup' })
      }
      return
    }
    if (msg.type !== 'sse-event' || !msg.event) return
    const evt = msg.event
    if (evt.type === 'session-updated' || evt.type === 'message-received') {
      this.loadSessions()
    }
  },

  // ── Editing mode ──

  onLongPress(e) {
    const { id } = e.currentTarget.dataset
    const session = this.data.sessions.find(s => s.id === id)
    if (!session || session.active) return  // active sessions can't be selected
    this.setData({ editing: true, selectedIds: [id] })
    this._markSelected()
  },

  onToggleSelect(e) {
    if (!this.data.editing) return
    const { id } = e.currentTarget.dataset
    const ids = this.data.selectedIds.slice()
    const idx = ids.indexOf(id)
    if (idx >= 0) ids.splice(idx, 1)
    else ids.push(id)
    this.setData({ selectedIds: ids })
    this._markSelected()
  },

  onSelectAll() {
    const allIds = this.data.sessions.filter(s => !s.active).map(s => s.id)
    const allSelected = allIds.length === this.data.selectedIds.length
    this.setData({ selectedIds: allSelected ? [] : allIds })
    this._markSelected()
  },

  onCancelEdit() {
    this.setData({ editing: false, selectedIds: [] })
    this._markSelected()
  },

  onDeleteSelected() {
    const ids = this.data.selectedIds
    if (ids.length === 0) return
    wx.showModal({
      title: '删除会话',
      content: `确定删除 ${ids.length} 个会话？删除后不可恢复。`,
      confirmColor: '#f53f3f',
      success: async (res) => {
        if (!res.confirm) return
        const relay = require('../../utils/relay')
        let failed = 0
        for (const id of ids) {
          try { await relay.deleteSession(id) }
          catch { failed++ }
        }
        this.setData({ editing: false, selectedIds: [] })
        if (failed > 0) {
          wx.showToast({ title: `${failed} 个删除失败`, icon: 'none' })
        } else {
          wx.showToast({ title: '已删除', icon: 'success' })
        }
        this.loadSessions()
      },
    })
  },

  _markSelected() {
    const ids = this.data.selectedIds
    const sessions = this.data.sessions.map(s => {
      s._selected = ids.indexOf(s.id) >= 0
      return s
    })
    this.setData({ sessions })
  },

  onCopyCmd() {
    wx.setClipboardData({
      data: 'npx @tina_summer/codepocket',
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    })
  },

  onRetryHub() {
    this.loadSessions()
  },

  // ── New session ──

  onNewSession() {
    this.setData({ showNewSession: true, newSessionDir: '', dirEntries: [], dirLoading: false, dirError: '', _currentDir: '' })
    this._loadDir('~')
  },

  onInputNewDir(e) {
    this.setData({ newSessionDir: e.detail.value })
  },

  onCancelNewSession() {
    this.setData({ showNewSession: false, dirEntries: [], dirLoading: false })
  },

  async _loadDir(dirPath) {
    this.setData({ dirLoading: true, dirError: '' })
    const relay = require('../../utils/relay')
    try {
      const res = await relay.listDir(dirPath)
      this.setData({ dirEntries: res.entries || [], dirLoading: false, newSessionDir: res.path, _currentDir: res.path })
    } catch (e) {
      this.setData({ dirEntries: [], dirLoading: false, dirError: e.message || '无法加载目录' })
    }
  },

  onLoadDir() {
    const dir = this.data.newSessionDir.trim()
    if (dir) this._loadDir(dir)
  },

  onTapDirEntry(e) {
    const { path } = e.currentTarget.dataset
    this.setData({ newSessionDir: path })
    this._loadDir(path)
  },

  onGoParentDir() {
    const current = this.data._currentDir || this.data.newSessionDir.trim()
    if (!current) return
    const parent = current.split('/').slice(0, -1).join('/') || '/'
    this.setData({ newSessionDir: parent })
    this._loadDir(parent)
  },

  async onConfirmNewSession() {
    const dir = this.data.newSessionDir.trim()
    if (!dir) {
      wx.showToast({ title: '请输入目录路径', icon: 'none' })
      return
    }
    this.setData({ spawning: true })
    const relay = require('../../utils/relay')
    try {
      const result = await relay.spawnSession(dir)
      this.setData({ showNewSession: false, spawning: false })
      if (result.sessionId) {
        wx.navigateTo({
          url: `/pages/chat/chat?sessionId=${result.sessionId}&name=${encodeURIComponent(dir)}`,
        })
      } else {
        wx.showToast({ title: '会话创建中...', icon: 'none' })
        setTimeout(() => this.loadSessions(), 2000)
      }
    } catch (e) {
      this.setData({ spawning: false })
      wx.showModal({
        title: '启动失败',
        content: e.message || '请确认终端已启动 codepocket',
        showCancel: false,
      })
    }
  },

  // ── Normal actions ──

  openSession(e) {
    if (this.data.editing) return
    const { id } = e.currentTarget.dataset
    const session = this.data.sessions.find(s => s.id === id)
    wx.navigateTo({
      url: `/pages/chat/chat?sessionId=${id}&name=${encodeURIComponent(session ? session.name : '')}`,
    })
  },

  onAbortSession(e) {
    if (this.data.editing) return
    const { id } = e.currentTarget.dataset
    wx.showModal({
      title: '终止会话',
      content: '确定要终止这个会话吗？',
      confirmColor: '#f53f3f',
      success: async (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '终止中...' })
        const relay = require('../../utils/relay')
        try {
          await relay.archiveSession(id)
          wx.hideLoading()
          wx.showToast({ title: '已终止', icon: 'success' })
          // Delay refresh to allow hub to update session state
          setTimeout(() => this.loadSessions(), 500)
        } catch (err) {
          wx.hideLoading()
          const msg = (err && err.message) || ''
          if (msg.includes('RPC handler not registered') || (err && err.status === 500)) {
            wx.showModal({ title: '终止失败', content: '该会话的终端进程已断开，请直接删除此会话。', showCancel: false })
          } else {
            wx.showToast({ title: '终止失败', icon: 'none' })
          }
        }
      },
    })
  },

  async onResumeSession(e) {
    const { id, name } = e.currentTarget.dataset
    const relay = require('../../utils/relay')
    wx.showToast({ title: '恢复中...', icon: 'loading', duration: 60000 })
    try {
      const result = await relay.resumeSession(id)
      wx.hideToast()
      if (result.sessionId) {
        // Pre-populate new session cache with old session messages
        try {
          const newCacheKey = `msg_cache_${result.sessionId}`
          let cached = false
          // Fast path: use existing cache if available
          const oldCache = wx.getStorageSync(`msg_cache_${id}`)
          if (oldCache && oldCache.messages && oldCache.messages.length > 0) {
            wx.setStorageSync(newCacheKey, oldCache)
            cached = true
          }
          // Fallback: fetch messages from server for old session
          if (!cached) {
            const data = await relay.getMessages(id, { limit: 200 })
            const raw = data.messages || []
            if (raw.length > 0) {
              const { createParser } = require('../../utils/message-parser')
              const parser = createParser()
              const messages = raw.map(m => parser.parseMessage(m)).filter(Boolean)
              if (messages.length > 0) {
                wx.setStorageSync(newCacheKey, {
                  messages,
                  hasMore: !!data.page?.hasMore,
                  nextBeforeSeq: data.page?.nextBeforeSeq || null,
                  savedAt: Date.now(),
                })
              }
            }
          }
        } catch {}
        wx.showToast({ title: '已恢复', icon: 'success' })
        this.loadSessions()
        // Navigate directly to the resumed conversation
        wx.navigateTo({
          url: `/pages/chat/chat?sessionId=${result.sessionId}&name=${encodeURIComponent(name || '对话')}`,
        })
      } else {
        wx.showToast({ title: '恢复中...', icon: 'none' })
        setTimeout(() => this.loadSessions(), 3000)
      }
    } catch (e) {
      wx.hideToast()
      const msg = (e && e.message) || ''
      wx.showModal({
        title: '恢复失败',
        content: msg || '请确认终端已启动 (codepocket)',
        showCancel: true,
        cancelText: '关闭',
        confirmText: '复制',
        success: (res) => {
          if (res.confirm) {
            wx.setClipboardData({
              data: `恢复失败 ${msg}`,
              success: () => wx.showToast({ title: '已复制', icon: 'success' }),
            })
          }
        },
      })
    }
  },

  _cleanMessageCaches(activeSessions) {
    try {
      const activeIds = new Set((activeSessions || []).map(s => s.id))
      const now = Date.now()
      const MAX_AGE = 7 * 24 * 60 * 60 * 1000 // 7 days
      const res = wx.getStorageInfoSync()
      const keys = res.keys || []
      for (const key of keys) {
        if (!key.startsWith('msg_cache_')) continue
        const sessionId = key.slice('msg_cache_'.length)
        // Remove cache for deleted sessions
        if (sessionId && activeIds.size > 0 && !activeIds.has(sessionId)) {
          wx.removeStorageSync(key)
          continue
        }
        // Remove expired caches
        try {
          const cached = wx.getStorageSync(key)
          if (cached && cached.savedAt && (now - cached.savedAt > MAX_AGE)) {
            wx.removeStorageSync(key)
          }
        } catch {}
      }
    } catch {}
  },

  noop() {},
})
