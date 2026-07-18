App({
  onLaunch() {
    const relay = require('./utils/relay')
    const key = wx.getStorageSync('relay_key')
    if (key) {
      // Establish WebSocket connection early; relay.js onMessage handles
      // token saving and handleRelayMessage internally.
      relay.connect(this.onGlobalEvent.bind(this))
    }
  },

  onGlobalEvent(msg) {
    // Key revoked/deleted on relay → notify user, do NOT auto-re-register
    if (msg.type === 'pair-error' && msg.code === 'invalid_key') {
      if (this._keyInvalidNotified) return
      this._keyInvalidNotified = true
      wx.showModal({
        title: 'Key 已失效',
        content: '你的连接 Key 已被禁用，请联系客服处理。',
        showCancel: false,
        confirmText: '我知道了',
      })
      return
    }
    // Reset flag on successful pair so future invalid_key can notify again
    if (msg.type === 'paired') {
      this._keyInvalidNotified = false
    }
    // Dispatch to all active pages
    const pages = getCurrentPages()
    for (const page of pages) {
      if (typeof page.onWsEvent === 'function') {
        page.onWsEvent(msg)
      }
    }
  },
})
