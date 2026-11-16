const relay = require('../../utils/relay')

Page({
  data: {
    step: 'loading',
    key: '',
    relayUrl: '',
    command: '',
    error: '',
    showTroubleshoot: false,
    showGuide: false,
    relayKey: '',
    relayUrlDisplay: '',
  },

  onLoad() {
    const key = wx.getStorageSync('relay_key')
    this._loadRelayUrlDisplay()
    if (key) {
      this.setData({ key, relayKey: key, step: 'show_command' })
      this.buildCommand(key)
      this.tryConnect(key)
    } else {
      this.register()
    }
  },

  _loadRelayUrlDisplay() {
    const custom = wx.getStorageSync('custom_relay_url')
    if (custom) {
      const display = custom.length > 24 ? custom.slice(0, 22) + '...' : custom
      this.setData({ relayUrlDisplay: display })
    } else {
      this.setData({ relayUrlDisplay: '' })
    }
  },

  onShowRelayConfig() {
    const current = wx.getStorageSync('custom_relay_url') || ''
    wx.showModal({
      title: 'Relay 地址',
      editable: true,
      content: current,
      placeholderText: 'wss://your-domain.com/ws',
      confirmText: '保存',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return
        const url = (res.content || '').trim()
        if (!url) {
          wx.removeStorageSync('custom_relay_url')
          this._loadRelayUrlDisplay()
          this.buildCommand(this.data.key)
          wx.showToast({ title: '已恢复默认地址', icon: 'none' })
          this.tryConnect(this.data.key, true)
          return
        }
        if (!/^wss?:\/\/.+/.test(url)) {
          wx.showToast({ title: '必须以 wss:// 或 ws:// 开头', icon: 'none' })
          return
        }
        wx.setStorageSync('custom_relay_url', url)
        this._loadRelayUrlDisplay()
        this.buildCommand(this.data.key)
        // 旧 socket 连的是旧 Relay,必须强制重连才会用新地址
        this.tryConnect(this.data.key, true)
      },
    })
  },

  onResetConnection() {
    wx.removeStorageSync('client_token')
    wx.removeStorageSync('session_token')
    this.tryConnect(this.data.key)
  },

  onResetKey() {
    wx.showModal({
      title: '重置 Key',
      content: '将清除本地 Key 并向 Relay 申请新 Key，继续？',
      confirmText: '重置',
      cancelText: '取消',
      confirmColor: '#eb5757',
      success: (res) => {
        if (!res.confirm) return
        wx.removeStorageSync('relay_key')
        wx.removeStorageSync('client_token')
        wx.removeStorageSync('session_token')
        this.register()
      },
    })
  },

  async register() {
    this.setData({ step: 'loading' })
    try {
      const data = await relay.registerKey()
      const key = data.key
      wx.setStorageSync('relay_key', key)
      this.setData({ key, relayKey: key, step: 'show_command' })
      this.buildCommand(key)
      this.tryConnect(key)
    } catch (e) {
      this.setData({ error: '注册失败，请检查网络后重试', step: 'show_command' })
    }
  },

  buildCommand(key) {
    const customRelay = wx.getStorageSync('custom_relay_url') || ''
    const relayFlag = customRelay ? ` --relay ${customRelay}` : ''
    const cmd = `npm i -g @tina_summer/codepocket && codepocket --key ${key}${relayFlag}`
    this.setData({ command: cmd, relayKey: key })
  },

  tryConnect(key, force = false) {
    this.setData({ step: 'connecting' })
    const onMsg = (msg) => {
      if (msg.type === 'paired' || msg.type === 'registered' || msg.type === 'client-connected') {
        if (msg.clientToken) wx.setStorageSync('client_token', msg.clientToken)
        if (msg.sessionToken) wx.setStorageSync('session_token', msg.sessionToken)
        this.setData({ step: 'connected' })
        wx.switchTab({ url: '/pages/index/index' })
      }
      if (msg.type === 'pair-error') {
        const code = msg.code || 'unknown'
        if (code === 'hub_offline') {
          // Valid key, computer hasn't connected yet — normal waiting state.
          // Keep step at 'connecting' so the waiting animation + command are visible.
          this.setData({ error: '' })
        } else if (code === 'rate_limited') {
          this.setData({ error: '尝试过于频繁，请 5 分钟后再试', step: 'show_command' })
        } else if (code === 'invalid_key') {
          this.setData({ error: 'Key 无效或已吊销，正在重新申请…', step: 'show_command' })
          // relay.js already cleared relay_key — re-register after showing the message
          setTimeout(() => this.register(), 1500)
        } else {
          this.setData({ error: msg.error || '配对失败，请重试', step: 'show_command' })
        }
      }
    }
    // Reuse the connection app.onLaunch already started (or an in-flight
    // handshake); a full force-reconnect (fresh TLS/WS) is only needed when
    // the relay URL just changed.
    if (force) relay.forceReconnect(onMsg)
    else relay.connect(onMsg)
    const clientToken = wx.getStorageSync('client_token') || ''
    const sessionToken = wx.getStorageSync('session_token') || ''
    relay.send({ type: 'pair', key: this.data.key, token: '', clientToken, sessionToken })
  },

  onCopyInstall() {
    wx.setClipboardData({
      data: 'npm i -g @tina_summer/codepocket',
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    })
  },

  onCopyRun() {
    wx.setClipboardData({
      data: 'codepocket',
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    })
  },

  onCopyCommand() {
    wx.setClipboardData({
      data: this.data.command,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    })
  },

  onRetry() {
    this.register()
  },

  onShowTroubleshoot() {
    const relayKey = wx.getStorageSync('relay_key') || ''
    this.setData({ showTroubleshoot: true, relayKey })
  },

  onHideTroubleshoot() {
    this.setData({ showTroubleshoot: false })
  },

  onCopyKey() {
    wx.setClipboardData({
      data: this.data.relayKey,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    })
  },

  onCopyCmd1() {
    wx.setClipboardData({
      data: 'cat ~/.codepocket/config.json',
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    })
  },

  onCopyCmd2() {
    wx.setClipboardData({
      data: 'codepocket',
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    })
  },

  onToggleGuide() {
    this.setData({ showGuide: !this.data.showGuide })
  },

  onCopyGithub() {
    wx.setClipboardData({
      data: 'https://github.com/TinaSummer/CodePocket',
      success: () => wx.showToast({ title: '已复制链接', icon: 'success' }),
    })
  },

  onGoGuide() {
    wx.navigateTo({ url: '/pages/guide/guide' })
  },
})
