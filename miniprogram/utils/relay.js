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
let stopped = false        // true when we intentionally stop retrying (rate_limited / invalid_key)
const MAX_RECONNECT = 20
const pendingQueue = []
let onPhoneActionCallback = null
let pingInterval = null

const defaultConfig = require('./config')
let localConfig = {}
try { localConfig = require('./config.local') } catch {}

const RELAY_URL = localConfig.relayUrl || defaultConfig.relayUrl

// ── End-to-end encryption (X25519 + XSalsa20-Poly1305) ──
// Relay only forwards e2ePubKey + opaque `enc` envelopes; it cannot decrypt.
// Nonces are counter-based with a direction tag: phone uses 0x00, connector 0xFF,
// so the two directions never collide under the same shared key.

const nacl = require('./tweetnacl')

let e2eKeypair = null          // { publicKey, secretKey } Uint8Arrays
let e2eKeypairPromise = null
let e2eSharedKey = null        // Uint8Array(32)
let e2eNonceCounter = 0

function u8ToB64(u8) {
  const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
  return wx.arrayBufferToBase64(buf)
}

function b64ToU8(b64) {
  return new Uint8Array(wx.base64ToArrayBuffer(b64))
}

function strToU8(str) {
  // UTF-8 encode without TextEncoder (mini-program may lack it)
  const bytes = []
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c < 0x80) bytes.push(c)
    else if (c < 0x800) { bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)) }
    else if (c < 0xd800 || c >= 0xe000) { bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)) }
    else { i++; const c2 = str.charCodeAt(i); const cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff)); bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)) }
  }
  return new Uint8Array(bytes)
}

function u8ToStr(u8) {
  let str = ''
  for (let i = 0; i < u8.length; ) {
    const b = u8[i++]
    if (b < 0x80) str += String.fromCharCode(b)
    else if (b < 0xe0) str += String.fromCharCode(((b & 0x1f) << 6) | (u8[i++] & 0x3f))
    else if (b < 0xf0) str += String.fromCharCode(((b & 0x0f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f))
    else { const cp = ((b & 0x07) << 18) | ((u8[i++] & 0x3f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f); const off = cp - 0x10000; str += String.fromCharCode(0xd800 | (off >> 10), 0xdc00 | (off & 0x3ff)) }
  }
  return str
}

function ensureE2EKeypair() {
  if (e2eKeypairPromise) return e2eKeypairPromise
  e2eKeypairPromise = new Promise((resolve, reject) => {
    const buf = new ArrayBuffer(32)
    wx.getRandomValues({
      buffer: buf,
      length: 32,
      success: () => {
        e2eKeypair = nacl.box.keyPair.fromSecretKey(new Uint8Array(buf))
        // Reset E2E state so the shared key is rebuilt from the new keypair
        // on the next `paired`. Without this, a hub restart (which forces
        // hub to rotate its keypair) leaves us encrypting with a stale
        // shared key the new hub cannot derive.
        e2eSharedKey = null
        e2eNonceCounter = 0
        e2eKeypairPromise = null
        resolve(e2eKeypair)
      },
      fail: (err) => { e2eKeypairPromise = null; reject(err) },
    })
  })
  return e2eKeypairPromise
}

function getE2EPubKeyB64() {
  return e2eKeypair ? u8ToB64(e2eKeypair.publicKey) : ''
}

function setPeerE2EPubKey(peerPubKeyB64) {
  if (!peerPubKeyB64 || !e2eKeypair) return
  try {
    const peerPub = b64ToU8(peerPubKeyB64)
    if (peerPub.length !== 32) return
    e2eSharedKey = nacl.box.before(peerPub, e2eKeypair.secretKey)
    e2eNonceCounter = 0
  } catch {}
}

function nextNonce() {
  e2eNonceCounter++
  const n = new Uint8Array(24)
  n[0] = 0x00  // phone→connector direction tag
  let c = e2eNonceCounter
  for (let i = 6; i >= 1; i--) { n[i] = c & 0xff; c = Math.floor(c / 256) }
  return n
}

const E2E_ROUTING = ['type', 'requestId', 'actionId', 'method', 'success', 'ok', 'reconnected', 'status']
const E2E_ENCRYPTABLE = {
  'rest-request': 1, 'rest-response': 1, 'sse-event': 1,
  'spawn-session': 1, 'spawn-session-result': 1,
  'resume-session': 1, 'resume-session-result': 1,
  'list-dir': 1, 'list-dir-result': 1,
  'auth-request': 1, 'auth-response': 1,
  'phone-action': 1, 'phone-action-response': 1,
}

function encryptMessage(msg) {
  if (!e2eSharedKey || !E2E_ENCRYPTABLE[msg.type]) return msg
  const content = {}
  for (const k in msg) {
    if (!E2E_ROUTING.includes(k)) content[k] = msg[k]
  }
  if (Object.keys(content).length === 0) return msg
  try {
    const plain = strToU8(JSON.stringify(content))
    const nonce = nextNonce()
    const cipher = nacl.secretbox(plain, nonce, e2eSharedKey)
    if (!cipher) return msg
    const out = {}
    for (const k of E2E_ROUTING) if (k in msg) out[k] = msg[k]
    out.enc = { n: u8ToB64(nonce), c: u8ToB64(cipher) }
    return out
  } catch { return msg }
}

function decryptMessage(msg) {
  if (!msg || !msg.enc || !e2eSharedKey) return msg
  try {
    const nonce = b64ToU8(msg.enc.n)
    const cipher = b64ToU8(msg.enc.c)
    const plain = nacl.secretbox.open(cipher, nonce, e2eSharedKey)
    if (!plain) return msg
    const content = JSON.parse(u8ToStr(plain))
    delete msg.enc
    for (const k in content) msg[k] = content[k]
  } catch {}
  return msg
}

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
  stopped = false  // user-initiated connect resets the stop flag

  // Already connected — just update callbacks
  if (isConnected && socketTask) {
    if (onConnectedCallback) onConnectedCallback()
    return
  }
  _openSocket(onEvent, onConnected)
}

// Force-close any existing socket and re-establish from scratch.
// Needed because connect() short-circuits when isConnected=true, which
// strands users on the setup page if they change custom_relay_url after
// a socket to the OLD relay is already open (pair-error:hub_offline loop).
function forceReconnect(onEvent, onConnected) {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null }
  if (socketTask) {
    try { socketTask.close({ fail() {} }) } catch {}
    socketTask = null
  }
  isConnected = false
  isPaired = false
  stopped = false
  // connect() would short-circuit on the flags above if they were true;
  // we just set them false, so it falls through to _openSocket().
  connect(onEvent, onConnected)
}

function _openSocket(onEvent, onConnected) {

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
    // Ensure E2E keypair is ready before pairing, so e2ePubKey can be included.
    // wx.getRandomValues is fast (~ms); this adds negligible latency to connection setup.
    ensureE2EKeypair().catch(() => null).then(() => {
      if (gen !== connectGeneration) return  // Stale handler
      // Auto pair with stored tokens + key
      const key = wx.getStorageSync('relay_key') || ''
      const ct = wx.getStorageSync('client_token') || ''
      const st = wx.getStorageSync('session_token') || ''
      if (key || ct || st) {
        socketTask.send({ data: JSON.stringify({ type: 'pair', token: '', key, clientToken: ct, sessionToken: st, e2ePubKey: getE2EPubKeyB64() }) })
      }
      // Send queued messages — inject e2ePubKey into any queued pair messages
      while (pendingQueue.length > 0) {
        const data = pendingQueue.shift()
        if (data && data.type === 'pair' && !data.e2ePubKey) data.e2ePubKey = getE2EPubKeyB64()
        socketTask.send({ data: JSON.stringify(encryptMessage(data)) })
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
  })

  socketTask.onMessage((res) => {
    if (gen !== connectGeneration) return  // Stale handler
    try {
      const msg = decryptMessage(JSON.parse(res.data))
      // Auto-save tokens from pairing
      if (msg.type === 'paired') {
        isPaired = true
        wx.setStorageSync('client_token', msg.clientToken || '')
        wx.setStorageSync('session_token', msg.sessionToken || '')
        reconnectAttempts = 0  // Reset only on successful pair
        if (msg.hubE2EPubKey) setPeerE2EPubKey(msg.hubE2EPubKey)
      }
      if (msg.type === 'pair-error') {
        isPaired = false
        const code = msg.code || 'unknown'
        // Only stop retrying for definitive "retrying won't help" codes.
        // rate_limited: retrying makes it worse. invalid_key: will never succeed.
        // Everything else (hub_offline, unknown/old-relay) → keep retrying.
        const shouldStop = (code === 'rate_limited' || code === 'invalid_key')
        if (shouldStop) {
          stopped = true
          if (code === 'invalid_key') {
            wx.removeStorageSync('client_token')
            wx.removeStorageSync('session_token')
            wx.removeStorageSync('relay_key')  // force re-register on next setup
          }
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
        } else {
          // hub_offline (valid key, computer not connected) or unknown (old relay) — retry
          wx.removeStorageSync('client_token')
          wx.removeStorageSync('session_token')
          if (reconnectAttempts < MAX_RECONNECT) {
            isConnected = false
            try { socketTask.close({ fail() {} }) } catch {}
            socketTask = null
            scheduleReconnect()
          }
        }
        if (onEventCallback) onEventCallback(msg)
        return
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
  if (stopped) return
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
    socketTask.send({ data: JSON.stringify(encryptMessage(data)) })
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
// Coalesce identical in-flight REST requests (same method+path+body) so that
// burst callers share one round-trip. Without this, every debounced reload
// that fires while a previous getMessages is still pending starts a second
// request through the same WS pipe — a recipe for 60s timeouts.
const inflightRest = new Map()

function restRequest(method, path, body) {
  // Only coalesce read-only GETs — POSTs may have side effects
  const canCoalesce = (method === 'GET')
  const key = canCoalesce ? `${method} ${path}` : null
  if (key && inflightRest.has(key)) return inflightRest.get(key)

  const requestId = `req_${++requestCounter}_${Date.now()}`
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId)
      if (key) inflightRest.delete(key)
      reject(new Error('Request timeout'))
    }, 20000)

    pendingRequests.set(requestId, { resolve, reject, timeout })
    send({ type: 'rest-request', requestId, method, path, body })
  })
  if (key) {
    inflightRest.set(key, promise)
    promise.then(() => { inflightRest.delete(key) }, () => { inflightRest.delete(key) })
  }
  return promise
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
  forceReconnect,
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
    const key = wx.getStorageSync('relay_key') || ''
    return new Promise((resolve, reject) => {
      wx.request({
        url: `${httpUrl}/share`,
        method: 'POST',
        data: { ...data, key },
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
