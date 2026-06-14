Page({
  onCopyClaude() {
    wx.setClipboardData({
      data: 'curl -fsSL https://claude.ai/install.sh | bash',
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    })
  },
  onCopyClaudeLatest() {
    wx.setClipboardData({
      data: 'curl -fsSL https://claude.ai/install.sh | bash -s latest',
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    })
  },
  onCopyCcSwitch() {
    wx.setClipboardData({
      data: 'https://github.com/farion1231/cc-switch',
      success: () => wx.showToast({ title: '已复制链接', icon: 'success' }),
    })
  },
  onCopyCcSwitchDl() {
    wx.setClipboardData({
      data: 'https://github.com/farion1231/cc-switch/releases/latest',
      success: () => wx.showToast({ title: '已复制链接', icon: 'success' }),
    })
  },
})
