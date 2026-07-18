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
    // Key revoked/deleted on relay → auto-redirect to setup for re-registration
    if (msg.type === 'pair-error' && msg.code === 'invalid_key') {
      if (this._keyInvalidHandled) return
      this._keyInvalidHandled = true
      wx.showModal({
        title: 'Key 已失效',
        content: '你的连接 Key 在服务端已失效，需要重新申请。',
        showCancel: false,
        confirmText: '重新申请',
        success: () => {
          wx.reLaunch({ url: '/pages/setup/setup' })
        },
      })
      return
    }
    // Reset flag on successful pair so future invalid_key can trigger again
    if (msg.type === 'paired') {
      this._keyInvalidHandled = false
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
