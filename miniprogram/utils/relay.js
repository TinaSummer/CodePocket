/**
 * Relay WebSocket 客户端 — 所有通信都通过一个 WebSocket 连接
 *
 * 协议:
 *   → { type: "pair", token: "abc...def" }
 *   → { type: "rest-request", requestId, method, path, body? }
 *   ← { type: "paired", sessionToken }
 *   ← { type: "sse-event", event }
 *   ← { type: "rest-response", requestId, status, data }
 */

let socketTask = null
let isConnected = false
let isPaired = false       // True only after server confirms pairing
let connectGeneration = 0  // Prevents stale handlers from interfering
let onEventCallback = null
let onConnectedCallback = null
let reconnectTimer = null
let reconnectAttempts = 0
const MAX_RECONNECT = 20
const pendingQueue = []
let onPhoneActionCallback = null
let pingInterval = null

const defaultConfig = require('./config')
let localConfig = {}
try { localConfig = require('./config.local') } catch {}

const RELAY_URL = localConfig.relayUrl || defaultConfig.relayUrl

function getRelayUrl() {
  // Priority: user-saved (wx.storage) > build-time config
  try {
    const saved = wx.getStorageSync('custom_relay_url')
    if (saved) return saved
  } catch {}
  return RELAY_URL
}

function getHttpUrl() {
  return getRelayUrl().replace('/ws', '').replace('wss://', 'https://').replace('ws://', 'http://')
}

function connect(onEvent, onConnected) {
  onEventCallback = onEvent
  onConnectedCallback = onConnected

  // Already connected — just update callbacks
  if (isConnected && socketTask) {
    if (onConnectedCallback) onConnectedCallback()
    return
  }

  const gen = ++connectGeneration

  isConnected = false
  isPaired = false
  const url = getRelayUrl()

  // Close existing socket safely
  if (socketTask) {
    try { socketTask.close({ fail() {} }) } catch {}
    socketTask = null
  }

  // Cancel pending reconnect
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  socketTask = wx.connectSocket({ url })

  // Per-socket handlers (not global) — prevents handler accumulation
  socketTask.onOpen(() => {
    if (gen !== connectGeneration) return  // Stale handler
    isConnected = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    // Auto pair with stored tokens + key
    const key = wx.getStorageSync('relay_key') || ''
    const ct = wx.getStorageSync('client_token') || ''
    const st = wx.getStorageSync('session_token') || ''
    if (key || ct || st) {
      socketTask.send({ data: JSON.stringify({ type: 'pair', token: '', key, clientToken: ct, sessionToken: st }) })
    }
    // Send queued messages
    while (pendingQueue.length > 0) {
      const data = pendingQueue.shift()
      socketTask.send({ data: JSON.stringify(data) })
    }
    // Start heartbeat to keep connection alive
    if (pingInterval) clearInterval(pingInterval)
    pingInterval = setInterval(() => {
      if (socketTask && isConnected) {
        socketTask.send({ data: JSON.stringify({ type: 'ping' }) })
      }
    }, 25000)
    if (onConnectedCallback) onConnectedCallback()
  })

  socketTask.onMessage((res) => {
    if (gen !== connectGeneration) return  // Stale handler
    try {
      const msg = JSON.parse(res.data)
      // Auto-save tokens from pairing
      if (msg.type === 'paired') {
        isPaired = true
        wx.setStorageSync('client_token', msg.clientToken || '')
        wx.setStorageSync('session_token', msg.sessionToken || '')
        reconnectAttempts = 0  // Reset only on successful pair
      }
      if (msg.type === 'pair-error') {
        isPaired = false
        wx.removeStorageSync('client_token')
        wx.removeStorageSync('session_token')
        // Hub might be temporarily offline — retry with backoff
        const key = wx.getStorageSync('relay_key') || ''
        if (key && reconnectAttempts < MAX_RECONNECT) {
          isConnected = false
          try { socketTask.close({ fail() {} }) } catch {}
          socketTask = null
          scheduleReconnect()
          return
        }
      }
      if (msg.type === 'sse-event') {
        // sse-event handled by callbacks below
      }
      if (msg.type === 'phone-action') {
        if (onPhoneActionCallback) onPhoneActionCallback(msg)
        return
      }
      handleRelayMessage(msg)
      if (onEventCallback) onEventCallback(msg)
    } catch {}
  })

  socketTask.onClose(() => {
    if (gen !== connectGeneration) return  // Stale handler
    isConnected = false
    isPaired = false
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null }
    scheduleReconnect()
  })

  socketTask.onError(() => {
    if (gen !== connectGeneration) return  // Stale handler
    isConnected = false
    isPaired = false
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null }
    scheduleReconnect()
  })
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT) return
  if (reconnectTimer) return
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
  reconnectAttempts++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect(onEventCallback)
  }, delay)
}

function send(data) {
  if (isConnected && socketTask) {
    socketTask.send({ data: JSON.stringify(data) })
    return true
  }
  pendingQueue.push(data)
  return true
}

// --- High-level API ---

function pair(token) {
  const clientToken = wx.getStorageSync('client_token') || ''
  const sessionToken = wx.getStorageSync('session_token') || ''
  return send({ type: 'pair', token, clientToken, sessionToken })
}

let requestCounter = 0
const pendingRequests = new Map()

function restRequest(method, path, body) {
  const requestId = `req_${++requestCounter}_${Date.now()}`
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId)
      reject(new Error('Request timeout'))
    }, 60000)

    pendingRequests.set(requestId, { resolve, reject, timeout })
    send({ type: 'rest-request', requestId, method, path, body })
  })
}

function sendPhoneActionResponse(actionId, accepted, result, error) {
  return send({
    type: 'phone-action-response',
    actionId,
    accepted: !!accepted,
    result: result || null,
    error: error || null,
  })
}

// Handle relay responses
function handleRelayMessage(msg) {
  if (msg.type === 'rest-response' && pendingRequests.has(msg.requestId)) {
    const { resolve, reject, timeout } = pendingRequests.get(msg.requestId)
    clearTimeout(timeout)
    pendingRequests.delete(msg.requestId)
    if (msg.status >= 200 && msg.status < 300) {
      resolve(msg.data)
    } else {
      const errMsg = (typeof msg.data === 'string') ? msg.data : (msg.data?.error || `HTTP ${msg.status}`)
      const err = new Error(errMsg)
      err.status = msg.status
      err.data = msg.data
      // Hub JWT invalid — don't clear relay tokens; connector should re-auth
      reject(err)
    }
  }

  if (msg.type === 'spawn-session-result' && pendingRequests.has(msg.requestId)) {
    const { resolve, reject, timeout } = pendingRequests.get(msg.requestId)
    clearTimeout(timeout)
    pendingRequests.delete(msg.requestId)
    if (msg.success) {
      resolve(msg)
    } else {
      reject(new Error(msg.error || 'Spawn failed'))
    }
  }

  if (msg.type === 'resume-session-result' && pendingRequests.has(msg.requestId)) {
    const { resolve, reject, timeout } = pendingRequests.get(msg.requestId)
    clearTimeout(timeout)
    pendingRequests.delete(msg.requestId)
    if (msg.success) {
      resolve(msg)
    } else {
      reject(new Error(msg.error || 'Resume failed'))
    }
  }

  if (msg.type === 'list-dir-result' && pendingRequests.has(msg.requestId)) {
    const { resolve, reject, timeout } = pendingRequests.get(msg.requestId)
    clearTimeout(timeout)
    pendingRequests.delete(msg.requestId)
    if (msg.error) {
      reject(new Error(msg.error))
    } else {
      resolve(msg)
    }
  }
}

// --- Convenience REST wrappers ---

async function getSessions() {
  return restRequest('GET', '/api/sessions')
}

async function getSession(id) {
  return restRequest('GET', `/api/sessions/${id}`)
}

function getMessages(sessionId, params = {}) {
  const defaults = { limit: 50 }
  const merged = { ...defaults, ...params }
  const qs = Object.entries(merged).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  return restRequest('GET', `/api/sessions/${sessionId}/messages?${qs}`)
}

async function sendMessage(sessionId, text, attachments) {
  const localId = `wx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  return restRequest('POST', `/api/sessions/${sessionId}/messages`, { text, localId, attachments })
}

async function uploadFile(sessionId, filename, content, mimeType) {
  return restRequest('POST', `/api/sessions/${sessionId}/upload`, { filename, content, mimeType })
}

async function readFile(sessionId, filePath) {
  return restRequest('GET', `/api/sessions/${sessionId}/file?path=${encodeURIComponent(filePath)}`)
}

async function getSessionDetail(sessionId) {
  return restRequest('GET', `/api/sessions/${sessionId}`)
}

async function approvePermission(sessionId, requestId, options = {}) {
  return restRequest('POST', `/api/sessions/${sessionId}/permissions/${requestId}/approve`, options)
}

async function denyPermission(sessionId, requestId) {
  return restRequest('POST', `/api/sessions/${sessionId}/permissions/${requestId}/deny`, {})
}

async function setPermissionMode(sessionId, mode) {
  return restRequest('POST', `/api/sessions/${sessionId}/permission-mode`, { mode })
}

async function abortSession(sessionId) {
  return restRequest('POST', `/api/sessions/${sessionId}/abort`)
}

async function archiveSession(sessionId) {
  return restRequest('POST', `/api/sessions/${sessionId}/archive`)
}

async function deleteSession(sessionId) {
  return restRequest('DELETE', `/api/sessions/${sessionId}`)
}

function resumeSession(sessionId) {
  return new Promise((resolve, reject) => {
    const requestId = 'resume_' + Date.now()
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId)
      reject(new Error('timeout'))
    }, 60000)
    pendingRequests.set(requestId, { resolve, reject, timeout })
    send({ type: 'resume-session', requestId, sessionId })
  })
}

function close() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (pingInterval) {
    clearInterval(pingInterval)
    pingInterval = null
  }
  reconnectAttempts = MAX_RECONNECT
  if (socketTask) {
    socketTask.close({ fail() {} })
    socketTask = null
  }
  isConnected = false
}

// Register a new user key via relay POST /register
function registerKey() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (loginRes) => {
        const url = getRelayUrl().replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/ws$/, '')
        wx.request({
          url: `${url}/register`,
          method: 'POST',
          data: { code: loginRes.code },
          success: (res) => {
            if ((res.statusCode === 200 || res.statusCode === 201) && res.data && res.data.key) {
              wx.setStorageSync('relay_key', res.data.key)
              resolve(res.data)
            } else {
              reject(new Error(res.data?.error || `Register failed: ${res.statusCode}`))
            }
          },
          fail: (err) => reject(err),
        })
      },
      fail: (err) => reject(err),
    })
  })
}

// Auto-connect with stored tokens (no QR scan needed)
function autoConnect(onEvent, onConnected) {
  // Already connected — just update callback
  if (isConnected && socketTask) {
    if (onEvent) onEventCallback = onEvent
    return true
  }

  // Check stored tokens or key
  const ct = wx.getStorageSync('client_token') || ''
  const st = wx.getStorageSync('session_token') || ''
  const key = wx.getStorageSync('relay_key') || ''
  if (!ct && !st && !key) return false

  // connect() handles pairing in onOpen — no separate pair message needed
  connect(onEvent, onConnected)
  return true
}

module.exports = {
  getRelayUrl,
  connect,
  send,
  pair,
  close,
  autoConnect,
  registerKey,
  getSessions,
  getSession,
  getMessages,
  sendMessage,
  uploadFile,
  readFile,
  getSessionDetail,
  approvePermission,
  denyPermission,
  setPermissionMode,
  abortSession,
  archiveSession,
  deleteSession,
  resumeSession,
  sendPhoneActionResponse,
  onPhoneAction: (cb) => { onPhoneActionCallback = cb },
  handleRelayMessage,
  isConnected: () => isConnected,
  isReady: () => isConnected && isPaired,
  getHttpUrl,

  // Upload share data to COS via relay server
  async uploadShare(data) {
    const httpUrl = RELAY_URL.replace('/ws', '').replace('wss://', 'https://').replace('ws://', 'http://')
    return new Promise((resolve, reject) => {
      wx.request({
        url: `${httpUrl}/share`,
        method: 'POST',
        data,
        success: (res) => {
          if (res.statusCode === 200 && res.data.id) resolve(res.data)
          else reject(new Error(res.data?.error || 'upload failed'))
        },
        fail: reject,
      })
    })
  },

  // Spawn a new Claude Code session in a directory
  spawnSession(directory) {
    return new Promise((resolve, reject) => {
      const requestId = 'spawn_' + Date.now()
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId)
        reject(new Error('timeout'))
      }, 45000)
      pendingRequests.set(requestId, { resolve, reject, timeout })
      send({ type: 'spawn-session', requestId, directory })
    })
  },

  // List directories at a given path
  listDir(dirPath) {
    return new Promise((resolve, reject) => {
      const requestId = 'ls_' + Date.now()
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId)
        reject(new Error('timeout'))
      }, 15000)
      pendingRequests.set(requestId, { resolve, reject, timeout })
      send({ type: 'list-dir', requestId, path: dirPath || '~' })
    })
  },

  /**
   * Ensure user has agreed to the privacy policy before calling privacy-sensitive APIs.
   * Shows a system popup on first call; cached for the session after agreement.
   * Returns a Promise — resolve means authorized, reject means user declined.
   */
  ensurePrivacyAuthorize() {
    return new Promise((resolve, reject) => {
      if (typeof wx.requirePrivacyAuthorize === 'function') {
        wx.requirePrivacyAuthorize({
          success: resolve,
          fail: reject,
        })
      } else {
        // Older base library without privacy API — skip check
        resolve()
      }
    })
  },
}
