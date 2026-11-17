const TOOL_TITLES = {
  phone_calendar_add: '添加日程',
  phone_todo_add: '添加待办',
  phone_todo_complete: '完成待办',
  phone_notification_send: '发送通知',
  phone_clipboard_write: '写入剪贴板',
}

function formatDateTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

Component({
  properties: {
    visible: { type: Boolean, value: false },
    actionId: { type: String, value: '' },
    tool: { type: String, value: '' },
    params: { type: Object, value: {} },
  },

  observers: {
    'params.startTime': function (ts) {
      this.setData({ timeDisplay: formatDateTime(ts) })
    },
    'params.dueDate': function (ts) {
      this.setData({ dueDateDisplay: formatDateTime(ts) })
    },
    'params.at': function (ts) {
      this.setData({ atDisplay: ts ? formatDateTime(ts) : '' })
    },
    'tool': function (tool) {
      this.setData({ modalTitle: TOOL_TITLES[tool] || '手机操作' })
    },
  },

  data: {
    modalTitle: '手机操作',
    timeDisplay: '',
    dueDateDisplay: '',
    atDisplay: '',
  },

  methods: {
    onConfirm() {
      this.triggerEvent('confirm', {
        actionId: this.data.actionId,
        tool: this.data.tool,
        params: this.data.params,
      })
    },

    preventBubble() {
      // noop — just prevents tap from bubbling to mask
    },

    onCancel() {
      this.triggerEvent('cancel', {
        actionId: this.data.actionId,
      })
    },
  },
})
