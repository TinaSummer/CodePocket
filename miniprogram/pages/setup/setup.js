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
  },

  onLoad() {
    const key = wx.getStorageSync('relay_key')
    if (key) {
      this.setData({ key, relayKey: key, step: 'show_command' })
      this.buildCommand(key)
      this.tryConnect(key)
    } else {
      this.register()
    }
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
    const cmd = `npm i -g @tina_summer/codepocket && codepocket --key ${key}`
    this.setData({ command: cmd, relayKey: key })
  },

  tryConnect(key) {
    this.setData({ step: 'connecting' })
    relay.connect((msg) => {
      if (msg.type === 'paired' || msg.type === 'registered' || msg.type === 'client-connected') {
        if (msg.clientToken) wx.setStorageSync('client_token', msg.clientToken)
        if (msg.sessionToken) wx.setStorageSync('session_token', msg.sessionToken)
        this.setData({ step: 'connected' })
        setTimeout(() => {
          wx.switchTab({ url: '/pages/index/index' })
        }, 600)
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
    })
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
