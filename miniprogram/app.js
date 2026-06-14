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
    // Dispatch to all active pages
    const pages = getCurrentPages()
    for (const page of pages) {
      if (typeof page.onWsEvent === 'function') {
        page.onWsEvent(msg)
      }
    }
  },
})
