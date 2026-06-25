const relay = require('../../utils/relay')
const { getAllPersonas, getSelectedPersona, setSelectedPersona, MBTI_TYPES, CUSTOM_PERSONAS } = require('../../utils/personas')
const RELAY_HTTP = relay.getRelayUrl().replace(/\/ws$/, '').replace(/^wss/, 'https').replace(/^ws/, 'http')

const PRESET_WALLPAPERS = [
  { id: 'paper', name: '纸张' },
  { id: 'misty', name: '薄雾' },
  { id: 'peach', name: '蜜桃' },
  { id: 'night', name: '暗夜' },
]

Page({
  data: {
    connected: false,
    version: 'v1.0.0',
    wallpaperName: '默认',
    showWallpaperPicker: false,
    selectedWallpaper: '',
    presetWallpapers: PRESET_WALLPAPERS,
    cardMode: false,
    showTroubleshoot: false,
    relayKey: '',
    showPersonaPicker: false,
    selectedPersonaId: '',
    personaName: '',
    customPersonas: [],
    mbtiGroups: [],
    isAdmin: false,
    showKeyManager: false,
    keyList: [],
    keyListLoading: false,
    showGuide: false,
    relayUrlDisplay: '',
  },

  onShow() {
    this.setData({ connected: relay.isConnected(), cardMode: wx.getStorageSync('chat_card_style') === '1' })
    this._loadWallpaperName()
    this._loadPersona()
    this._checkAdmin()
    this._loadRelayUrlDisplay()
  },

  _loadRelayUrlDisplay() {
    const custom = wx.getStorageSync('custom_relay_url')
    if (custom) {
      // Truncate long URLs for display
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
          wx.showToast({ title: '已恢复默认地址', icon: 'none' })
          return
        }
        if (!/^wss?:\/\/.+/.test(url)) {
          wx.showToast({ title: '必须以 wss:// 或 ws:// 开头', icon: 'none' })
          return
        }
        wx.setStorageSync('custom_relay_url', url)
        this._loadRelayUrlDisplay()
        wx.showModal({
          title: '已保存',
          content: '需要重新配对才能生效,现在去配对吗?',
          confirmText: '去配对',
          cancelText: '稍后',
          success: (r) => {
            if (r.confirm) this.onReconnect()
          },
        })
      },
    })
  },

  _checkAdmin() {
    const key = wx.getStorageSync('relay_key')
    if (!key) return
    wx.request({
      url: `${RELAY_HTTP}/register/admin/check`,
      method: 'POST',
      data: { key },
      success: (res) => {
        if (res.data?.isAdmin) this.setData({ isAdmin: true })
      },
    })
  },

  _loadPersona() {
    const persona = getSelectedPersona()
    this.setData({
      selectedPersonaId: persona ? persona.id : '',
      personaName: persona ? persona.name : '',
    })
  },

  _loadWallpaperName() {
    try {
      const wp = wx.getStorageSync('chat_wallpaper')
      if (!wp) {
        this.setData({ wallpaperName: '默认', selectedWallpaper: '' })
        return
      }
      if (wp.type === 'preset') {
        const p = PRESET_WALLPAPERS.find(item => item.id === wp.id)
        this.setData({ wallpaperName: p ? p.name : wp.id, selectedWallpaper: wp.id })
      } else if (wp.type === 'custom') {
        this.setData({ wallpaperName: '自定义', selectedWallpaper: '__custom__' })
      }
    } catch {
      this.setData({ wallpaperName: '默认', selectedWallpaper: '' })
    }
  },

  onReconnect() {
    this.onHideTroubleshoot()
    wx.redirectTo({ url: '/pages/setup/setup' })
  },

  onShowTroubleshoot() {
    this.setData({ showTroubleshoot: true, relayKey: wx.getStorageSync('relay_key') || '' })
  },

  onHideTroubleshoot() {
    this.setData({ showTroubleshoot: false })
  },

  onCopyKey() {
    wx.setClipboardData({ data: this.data.relayKey, success: () => wx.showToast({ title: '已复制', icon: 'success' }) })
  },

  onCopyCmd1() {
    wx.setClipboardData({ data: 'cat ~/.codepocket/config.json', success: () => wx.showToast({ title: '已复制', icon: 'success' }) })
  },

  onCopyCmd2() {
    wx.setClipboardData({ data: 'codepocket connect', success: () => wx.showToast({ title: '已复制', icon: 'success' }) })
  },

  onToggleWallpaperPicker() {
    this.setData({ showWallpaperPicker: !this.data.showWallpaperPicker })
  },

  onSelectWallpaper(e) {
    const id = e.currentTarget.dataset.id
    if (id === '') {
      wx.removeStorageSync('chat_wallpaper')
      this.setData({ selectedWallpaper: '', wallpaperName: '默认' })
      wx.showToast({ title: '已恢复默认', icon: 'none' })
      return
    }
    const preset = { type: 'preset', id }
    wx.setStorageSync('chat_wallpaper', preset)
    const p = PRESET_WALLPAPERS.find(item => item.id === id)
    this.setData({ selectedWallpaper: id, wallpaperName: p ? p.name : id })
    wx.showToast({ title: '壁纸已更换', icon: 'none' })
  },

  onToggleCardMode() {
    const newMode = !this.data.cardMode
    wx.setStorageSync('chat_card_style', newMode ? '1' : '')
    this.setData({ cardMode: newMode })
  },

  async onChooseCustomWallpaper() {
    const relay = require('../../utils/relay')
    try { await relay.ensurePrivacyAuthorize() } catch { return }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album'],
      success: (res) => {
        const tempPath = res.tempFiles[0].tempFilePath
        const fs = wx.getFileSystemManager()
        const savedPath = `${wx.env.USER_DATA_PATH}/wallpaper_custom.jpg`
        try {
          // Copy to persistent user data dir
          fs.saveFileSync(tempPath, savedPath)
        } catch {
          fs.unlinkSync(savedPath)
          fs.saveFileSync(tempPath, savedPath)
        }
        wx.setStorageSync('chat_wallpaper', { type: 'custom', path: savedPath })
        this.setData({ selectedWallpaper: '__custom__', wallpaperName: '自定义' })
        wx.showToast({ title: '壁纸已更换', icon: 'none' })
      },
    })
  },

  // ── Persona picker ──

  onShowPersonaPicker() {
    const groups = [
      { group: 'analyst', label: '分析家', types: MBTI_TYPES.filter(t => t.group === 'analyst') },
      { group: 'diplomat', label: '外交家', types: MBTI_TYPES.filter(t => t.group === 'diplomat') },
      { group: 'sentinel', label: '守护者', types: MBTI_TYPES.filter(t => t.group === 'sentinel') },
      { group: 'explorer', label: '探险家', types: MBTI_TYPES.filter(t => t.group === 'explorer') },
    ]
    this.setData({
      showPersonaPicker: true,
      customPersonas: CUSTOM_PERSONAS,
      mbtiGroups: groups,
    })
  },

  onHidePersonaPicker() {
    this.setData({ showPersonaPicker: false })
  },

  onSelectPersona(e) {
    const id = e.currentTarget.dataset.id
    if (!id) {
      setSelectedPersona('')
      this.setData({ selectedPersonaId: '', personaName: '', showPersonaPicker: false })
      wx.showToast({ title: '已恢复默认', icon: 'none' })
      return
    }
    const persona = getAllPersonas().find(p => p.id === id)
    if (!persona) return
    setSelectedPersona(id)
    this.setData({ selectedPersonaId: id, personaName: persona.name, showPersonaPicker: false })
    wx.showToast({ title: `已切换为 ${persona.name}`, icon: 'none' })
  },

  // ── Key Management (admin only) ──

  onShowKeyManager() {
    this.setData({ showKeyManager: true, keyListLoading: true, keyList: [] })
    const key = wx.getStorageSync('relay_key')
    wx.request({
      url: `${RELAY_HTTP}/register/admin/keys`,
      method: 'POST',
      data: { key },
      success: (res) => {
        if (res.data?.keys) {
          const sorted = res.data.keys.sort((a, b) => {
            if (a.revoked !== b.revoked) return a.revoked ? 1 : -1
            if (a.paired !== b.paired) return a.paired ? -1 : 1
            return (b.lastPairedAt || b.created) - (a.lastPairedAt || a.created)
          })
          this.setData({ keyList: sorted, keyListLoading: false })
        } else {
          this.setData({ keyListLoading: false })
          wx.showToast({ title: '加载失败', icon: 'none' })
        }
      },
      fail: () => {
        this.setData({ keyListLoading: false })
        wx.showToast({ title: '网络错误', icon: 'none' })
      },
    })
  },

  onHideKeyManager() {
    this.setData({ showKeyManager: false })
  },

  onRevokeKey(e) {
    const { id, name } = e.currentTarget.dataset
    wx.showModal({
      title: '禁用 Key',
      content: `确定禁用 ${name} 的 Key？该用户下次打开小程序会自动获得新 Key。`,
      success: (res) => {
        if (!res.confirm) return
        const key = wx.getStorageSync('relay_key')
        wx.request({
          url: `${RELAY_HTTP}/register/admin/revoke`,
          method: 'POST',
          data: { key, id },
          success: (res) => {
            if (res.data?.ok) {
              wx.showToast({ title: '已禁用', icon: 'success' })
              this.onShowKeyManager() // refresh
            } else {
              wx.showToast({ title: res.data?.error || '操作失败', icon: 'none' })
            }
          },
        })
      },
    })
  },

  onShowGuide() {
    this.setData({ showGuide: true })
  },

  onGoGuide() {
    this.setData({ showGuide: false })
    wx.navigateTo({ url: '/pages/guide/guide' })
  },

  onHideGuide() {
    this.setData({ showGuide: false })
  },

  onCopyInstallCmd() {
    const key = wx.getStorageSync('relay_key') || 'YOUR_KEY'
    wx.setClipboardData({
      data: `npm i -g @tina_summer/codepocket && codepocket --key ${key}`,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    })
  },

  onCopyCodepocket() {
    wx.setClipboardData({
      data: 'codepocket',
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    })
  },

  onCopyRunKey() {
    const key = wx.getStorageSync('relay_key') || 'YOUR_KEY'
    wx.setClipboardData({
      data: `codepocket --key ${key}`,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    })
  },

  onCopyGithub() {
    wx.setClipboardData({
      data: 'https://github.com/TinaSummer/CodePocket',
      success: () => wx.showToast({ title: '已复制链接', icon: 'success' }),
    })
  },
})
