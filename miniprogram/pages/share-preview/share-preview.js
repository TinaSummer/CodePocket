const { createParser } = require('../../utils/message-parser')

Page({
  data: {
    sessions: [],
    loading: true,
    shareId: '',
    shareUrl: '',
  },

  async onLoad(options) {
    // Mode 1: View shared conversation from COS link (shareId param)
    if (options && options.shareId) {
      this.setData({ shareId: options.shareId })
      await this._loadFromCOS(options.shareId)
      return
    }

    // Mode 2: Preview before sharing (from storage)
    const shareMessages = wx.getStorageSync('share_messages')
    if (shareMessages && shareMessages.messages) {
      wx.removeStorageSync('share_messages')
      this.setData({
        sessions: [{
          id: 'selected',
          name: shareMessages.name || '对话',
          path: shareMessages.path || '',
          agent: shareMessages.agent || 'Claude',
          messages: shareMessages.messages,
        }],
        loading: false,
      })
      return
    }

    // Mode 3: Legacy session-level data
    const shareData = wx.getStorageSync('share_sessions') || []
    if (shareData.length === 0) {
      wx.navigateBack()
      return
    }

    const relay = require('../../utils/relay')
    const sessions = []

    for (const s of shareData) {
      const parser = createParser()
      try {
        const data = await relay.getMessages(s.id)
        const raw = data.messages || []
        const messages = raw.map(m => parser.parseMessage(m)).filter(Boolean)
        const merged = parser.mergeToolCallMessages(messages, {})
        const capped = merged.slice(-20)
        sessions.push({ id: s.id, name: s.name, path: s.path, agent: s.agent, messages: capped })
      } catch (e) {
        console.error('[share-preview] load failed for', s.id, e)
      }
    }

    wx.removeStorageSync('share_sessions')
    this.setData({ sessions, loading: false })
  },

  async _loadFromCOS(shareId) {
    try {
      const { getHttpUrl } = require('../../utils/relay')
      const httpUrl = getHttpUrl()
      const res = await new Promise((resolve, reject) => {
        wx.request({
          url: `${httpUrl}/share/${shareId}`,
          success: (r) => r.statusCode === 200 ? resolve(r.data) : reject(new Error('not found')),
          fail: reject,
        })
      })

      this.setData({
        sessions: [{
          id: shareId,
          name: res.name || '对话',
          path: '',
          agent: res.agent || 'Claude',
          messages: res.messages || [],
        }],
        loading: false,
      })
    } catch (e) {
      console.error('[share-preview] COS load failed', e)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  onToggleGroup(e) {
    const { sessionIdx, msgIdx, blockIdx } = e.currentTarget.dataset
    const si = parseInt(sessionIdx, 10)
    const mi = parseInt(msgIdx, 10)
    const bi = parseInt(blockIdx, 10)
    const sessions = this.data.sessions
    const block = sessions[si]?.messages[mi]?.blocks[bi]
    if (!block || block.type !== 'tool-group') return
    const key = `sessions[${si}].messages[${mi}].blocks[${bi}].expanded`
    this.setData({ [key]: !block.expanded })
  },

  onToggleThinking(e) {
    const { sessionIdx, msgIdx, blockIdx } = e.currentTarget.dataset
    const si = parseInt(sessionIdx, 10)
    const mi = parseInt(msgIdx, 10)
    const bi = parseInt(blockIdx, 10)
    const sessions = this.data.sessions
    const block = sessions[si]?.messages[mi]?.blocks[bi]
    if (!block || block.type !== 'thinking') return
    const key = `sessions[${si}].messages[${mi}].blocks[${bi}].expanded`
    this.setData({ [key]: !block.expanded })
  },

  async onSaveImage() {
    if (this._exporting) return
    this._exporting = true
    wx.showLoading({ title: '生成图片...' })

    try {
      const query = wx.createSelectorQuery()
      query.select('#shareCanvas').fields({ node: true, size: true }).exec(async (res) => {
        if (!res || !res[0]) {
          this._exporting = false
          wx.hideLoading()
          return
        }

        const canvas = res[0].node
        const { layoutAndPaint } = require('../../utils/canvas-renderer')
        const config = { width: 750, maxMsgPerSession: 30, maxTextLen: 500 }

        try {
          layoutAndPaint(this.data.sessions, canvas, config)
        } catch (e) {
          console.error('[share-preview] render failed', e.message, e.stack)
          this._exporting = false
          wx.hideLoading()
          wx.showToast({ title: '渲染失败', icon: 'none' })
          return
        }

        await new Promise(r => setTimeout(r, 300))

        wx.canvasToTempFilePath({
          canvas,
          success: async (imgRes) => {
            wx.hideLoading()
            const relay = require('../../utils/relay')
            try { await relay.ensurePrivacyAuthorize() } catch { this._exporting = false; return }
            wx.saveImageToPhotosAlbum({
              filePath: imgRes.tempFilePath,
              success: () => {
                this._exporting = false
                wx.showModal({ title: '已保存到相册', content: '可以去微信发图给朋友分享', showCancel: false, confirmText: '好的' })
              },
              fail: (err) => {
                this._exporting = false
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
            wx.hideLoading()
            wx.showToast({ title: '导出失败', icon: 'none' })
          },
        })
      })
    } catch (e) {
      this._exporting = false
      wx.hideLoading()
      console.error('[share-preview] export error', e)
    }
  },

  onShareAppMessage() {
    const name = (this.data.sessions[0] && this.data.sessions[0].name) || 'CodePocket'
    const path = this.data.shareId ? `/pages/share-preview/share-preview?shareId=${this.data.shareId}` : '/pages/index/index'
    console.log('[share-preview] onShareAppMessage, shareId:', this.data.shareId, 'path:', path)
    return {
      title: `${name} — CodePocket`,
      path,
    }
  },
})
