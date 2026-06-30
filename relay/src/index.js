/**
 * CodePocket Relay — Node.js 版
 *
 * 安全机制:
 *   - ADMIN_KEY: 管理员密钥，用于管理用户 key
 *   - 用户 key 持久化到 keys.json，无需重启服务
 *   - 配对码 10 分钟过期
 *   - session token 验证所有后续消息
 *   - 频率限制: 10 次失败/5 分钟/IP
 *
 * Admin API:
 *   POST   /admin/keys          创建用户 key (body: {name: "用户名"})
 *   GET    /admin/keys          列出所有 key
 *   DELETE /admin/keys/:id      吊销 key
 *   Header: Authorization: Bearer <ADMIN_KEY>
 */

const { Hono } = require('hono')
const { serve } = require('@hono/node-server')
const { createNodeWebSocket } = require('@hono/node-ws')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const app = new Hono()
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app })

// ── Global error guards: prevent process crash ──
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err.message, err.stack)
})
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] unhandledRejection:', err)
})

const RELAY_PORT = parseInt(process.env.RELAY_PORT || '3010')
const ADMIN_KEY = process.env.RELAY_KEYS || process.env.ADMIN_KEY || ''
const WX_APPID = process.env.WX_APPID || ''
const WX_SECRET = process.env.WX_SECRET || ''
const ADMIN_OPENIDS = (process.env.ADMIN_OPENIDS || '')
  .split(',').map(s => s.trim()).filter(Boolean)
const DATA_DIR = process.env.DATA_DIR || '/opt/codepocket-relay/data'
const KEYS_FILE = path.join(DATA_DIR, 'keys.json')

// ── COS config (optional, for share links) ──
const COS_SECRET_ID = process.env.COS_SECRET_ID || ''
const COS_SECRET_KEY = process.env.COS_SECRET_KEY || ''
const COS_REGION = process.env.COS_REGION || 'ap-shanghai'
const COS_BUCKET = process.env.COS_BUCKET || ''
const COS_BUCKET_URL = process.env.COS_BUCKET_URL || (COS_BUCKET ? `https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com` : '')

let _cosClient = null
function cosClient() {
  if (!COS_SECRET_ID) return null
  if (!_cosClient) {
    const COS = require('cos-nodejs-sdk-v5')
    _cosClient = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY })
  }
  return _cosClient
}
const PAIR_CODE_TTL = 10 * 60 * 1000

if (!ADMIN_KEY) {
  console.error('[!] 必须设置 ADMIN_KEY 环境变量 (管理员密钥)')
  process.exit(1)
}

// ── Key Management (persistent, with in-memory cache) ──

let _keysCache = null
let _keysCacheTime = 0
const KEYS_CACHE_TTL = 5000 // 5 seconds

function loadKeys() {
  const now = Date.now()
  if (_keysCache && now - _keysCacheTime < KEYS_CACHE_TTL) return _keysCache
  try {
    _keysCache = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'))
  } catch {
    _keysCache = []
  }
  _keysCacheTime = now
  return _keysCache
}

function saveKeys(keys) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2))
  _keysCache = keys
  _keysCacheTime = Date.now()
}

function isValidKey(key) {
  return loadKeys().some(k => k.key === key && !k.revoked)
}

// Initialize with a default key if empty
if (loadKeys().length === 0) {
  const defaultKey = crypto.randomBytes(32).toString('hex')
  saveKeys([{ id: 'default', key: defaultKey, name: '默认用户', created: Date.now(), revoked: false }])
  console.log(`[relay] 自动生成默认用户 key: ${defaultKey.slice(0, 8)}...`)
}

console.log(`[relay] loaded ${loadKeys().filter(k => !k.revoked).length} user key(s)`)

// ── State ──

const hubs = new Map()
const clients = new Map()
const pendingPairs = new Map()
const pendingRestRequests = new Map()
const pendingAuthRequests = new Map()
const pendingPhoneActions = new Map()
const pendingSpawnRequests = new Map()
const pendingResumeRequests = new Map()
const pendingListDirRequests = new Map()
const failedAttempts = new Map()
const connState = new Map()
const regAttempts = new Map()
const MAX_REG = 5
const REG_WINDOW = 60 * 60 * 1000 // 1 hour

const MAX_FAILED = 10
const FAIL_WINDOW = 5 * 60 * 1000

function genToken() {
  return Array.from(crypto.randomBytes(32), b => b.toString(16).padStart(2, '0')).join('')
}

function checkRateLimit(ip) {
  const r = failedAttempts.get(ip)
  if (!r) return true
  if (Date.now() - r.lastAttempt > FAIL_WINDOW) { failedAttempts.delete(ip); return true }
  return r.count < MAX_FAILED
}

function recordFail(ip) {
  const r = failedAttempts.get(ip) || { count: 0, lastAttempt: 0 }
  r.count++; r.lastAttempt = Date.now()
  failedAttempts.set(ip, r)
}

function getHub(ws) {
  const s = connState.get(ws)
  if (!s || !s.hubToken) return null
  return hubs.get(s.hubToken) || null
}

function findHubByClient(ws) {
  const s = connState.get(ws)
  if (!s?.clientToken) {
    console.log(`[relay] findHubByClient: no clientToken hubs=${hubs.size} clients=${clients.size}`)
    return null
  }
  const client = clients.get(s.clientToken)
  if (!client) {
    console.log(`[relay] findHubByClient: no client for ${s.clientToken.slice(0, 8)}`)
    return null
  }
  if (!client.hubToken) {
    console.log(`[relay] findHubByClient: client has no hubToken`)
    return null
  }
  const hub = hubs.get(client.hubToken)
  if (!hub) {
    console.log(`[relay] findHubByClient: hub not found for ${client.hubToken.slice(0, 8)} hubs=${hubs.size}`)
  }
  return hub || null
}

function cleanupHub(token) {
  const hub = hubs.get(token)
  if (!hub) return
  for (const cws of hub.clients) {
    const cs = connState.get(cws)
    if (cs) cs.hubToken = null
    try { cws.send(JSON.stringify({ type: 'hub-disconnected' })) } catch {}
  }
  hubs.delete(token)
}

// Periodic cleanup
setInterval(() => {
  const now = Date.now()
  for (const [token, id] of pendingPairs) {
    const h = hubs.get(id)
    if (!h || now > h.tokenExpires) { pendingPairs.delete(token); if (h) h.token = '' }
  }
  for (const [id, r] of pendingRestRequests) { if (now > r.expires) pendingRestRequests.delete(id) }
  for (const [id, r] of pendingAuthRequests) { if (now > r.expires) pendingAuthRequests.delete(id) }
  for (const [id, r] of pendingPhoneActions) { if (now > r.expires) pendingPhoneActions.delete(id) }
  for (const [id, r] of pendingSpawnRequests) { if (now > r.expires) pendingSpawnRequests.delete(id) }
  for (const [id, r] of pendingResumeRequests) { if (now > r.expires) pendingResumeRequests.delete(id) }
  for (const [id, r] of pendingListDirRequests) { if (now > r.expires) pendingListDirRequests.delete(id) }
  for (const [ip, r] of failedAttempts) { if (now - r.lastAttempt > FAIL_WINDOW) failedAttempts.delete(ip) }
  for (const [ip, r] of regAttempts) { if (now - r.lastAttempt > REG_WINDOW) regAttempts.delete(ip) }
}, 60000)

// ── Admin API ──

function isAdminKey(key) {
  if (!key) return false
  if (ADMIN_KEY && timingSafeEqual(key, ADMIN_KEY)) return true
  // Admin-flagged user key (set via ADMIN_OPENIDS openid match)
  const ownerKey = loadKeys().find(k => timingSafeEqual(k.key, key) && !k.revoked)
  return !!(ownerKey && ownerKey.admin)
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return crypto.timingSafeEqual(bufA, bufB)
}

app.post('/register/admin/check', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const key = String(body.key || '')

  // Openid path: wx.login code present → resolve openid → upgrade key if admin
  if (body.code && WX_APPID && WX_SECRET) {
    const openId = await getOpenId(String(body.code))
    if (openId) {
      // Backfill openId on the caller's key if missing (covers keys registered before WX_APPID was set)
      if (key) {
        const keys = loadKeys()
        const owner = keys.find(k => timingSafeEqual(k.key, key) && !k.revoked)
        if (owner && !owner.openId) {
          owner.openId = openId
          saveKeys(keys)
          console.log(`[admin/check] backfilled openId on key "${owner.name}"`)
        }
      }
      if (ADMIN_OPENIDS.includes(openId)) {
        // Promote the caller's existing key to admin status
        const keys = loadKeys()
        const owner = key ? keys.find(k => timingSafeEqual(k.key, key) && !k.revoked) : null
        if (owner && !owner.admin) {
          owner.admin = true
          saveKeys(keys)
          console.log(`[admin/check] upgraded key "${owner.name}" to admin via openid`)
        }
        return c.json({ isAdmin: true })
      }
      // openid resolved but not in whitelist — log so operator can discover their openid
      console.log(`[admin/check] openid=${openId} not in ADMIN_OPENIDS (add to env to grant admin)`)
    }
    // fall through to legacy ADMIN_KEY check
  }

  return c.json({ isAdmin: isAdminKey(key) })
})

function checkAdmin(c) {
  const auth = c.req.header('Authorization') || ''
  const token = auth.replace('Bearer ', '')
  if (!timingSafeEqual(token, ADMIN_KEY)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  return null
}

// List keys (Bearer token auth — legacy)
app.get('/register/admin/keys', (c) => {
  const err = checkAdmin(c)
  if (err) return err
  const keys = loadKeys().map(k => ({
    id: k.id, name: k.name, created: k.created,
    paired: !!k.lastPairedAt, lastPairedAt: k.lastPairedAt || null,
    revoked: !!k.revoked, revokedAt: k.revokedAt || null,
  }))
  return c.json({ keys })
})

// List keys (body key auth — used by mini-program)
app.post('/register/admin/keys', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (!isAdminKey(String(body.key || ''))) return c.json({ error: 'Unauthorized' }, 401)
  const keys = loadKeys().map(k => ({
    id: k.id, name: k.name, created: k.created,
    paired: !!k.lastPairedAt, lastPairedAt: k.lastPairedAt || null,
    revoked: !!k.revoked, revokedAt: k.revokedAt || null,
  }))
  return c.json({ keys })
})

// Revoke key (body key auth — used by mini-program)
app.post('/register/admin/revoke', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (!isAdminKey(String(body.key || ''))) return c.json({ error: 'Unauthorized' }, 401)
  const { id } = body
  if (!id) return c.json({ error: 'Provide id' }, 400)
  const keys = loadKeys()
  const target = keys.find(k => k.id === id)
  if (!target) return c.json({ error: 'Key not found' }, 404)
  if (target.revoked) return c.json({ error: 'Already revoked' }, 200)
  target.revoked = true
  target.revokedAt = Date.now()
  saveKeys(keys)
  console.log(`[admin] revoked key "${target.name}" (id=${target.id})`)
  return c.json({ ok: true, name: target.name, id: target.id })
})

// ── Share: upload conversation JSON to COS ──

app.post('/share', async (c) => {
  const cos = cosClient()
  if (!cos) return c.json({ error: 'COS not configured' }, 503)

  const body = await c.req.json().catch(() => null)
  if (!body || !body.name || !body.messages) {
    return c.json({ error: 'missing name or messages' }, 400)
  }
  if (!Array.isArray(body.messages) || body.messages.length > 500) {
    return c.json({ error: 'messages must be an array with at most 500 items' }, 400)
  }

  const id = crypto.randomUUID().slice(0, 12)
  const key = `shares/${id}.json`

  try {
    await new Promise((resolve, reject) => {
      cos.putObject({
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Key: key,
        Body: JSON.stringify({ name: body.name, agent: body.agent || 'Claude', messages: body.messages }),
        ContentType: 'application/json',
        ACL: 'public-read',
      }, (err) => err ? reject(err) : resolve())
    })

    const url = `${COS_BUCKET_URL}/${key}`
    console.log(`[share] uploaded ${id}, ${body.messages.length} messages`)
    return c.json({ id, url })
  } catch (e) {
    console.error('[share] upload failed:', e.message)
    return c.json({ error: 'upload failed' }, 500)
  }
})

app.get('/share/:id', async (c) => {
  const cos = cosClient()
  if (!cos) return c.json({ error: 'COS not configured' }, 503)

  const id = c.req.param('id')
  const key = `shares/${id}.json`

  try {
    const data = await new Promise((resolve, reject) => {
      cos.getObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: key }, (err, res) => {
        if (err) reject(err)
        else resolve(res.Body.toString())
      })
    })
    return c.json(JSON.parse(data))
  } catch {
    return c.json({ error: 'not found' }, 404)
  }
})

// ── Health check ──

app.get('/', (c) => c.json({
  name: 'codepocket-relay',
  version: '2.0.0',
  connections: { hubs: hubs.size, clients: clients.size },
  keys: loadKeys().filter(k => !k.revoked).length,
}))

// ── Public Registration ──

async function getOpenId(code) {
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${WX_APPID}&secret=${WX_SECRET}&js_code=${code}&grant_type=authorization_code`
  const res = await fetch(url)
  const data = await res.json()
  return data.openid || null
}

app.post('/register', async (c) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown'
  const r = regAttempts.get(ip)
  if (r && Date.now() - r.lastAttempt <= REG_WINDOW && r.count >= MAX_REG) {
    return c.json({ error: 'Too many registrations, try again later' }, 429)
  }

  // Get open_id via WeChat code2Session
  const body = await c.req.json().catch(() => ({}))
  let openId = ''
  if (body.code && WX_APPID && WX_SECRET) {
    openId = await getOpenId(body.code)
    if (!openId) {
      return c.json({ error: 'Invalid WeChat code' }, 400)
    }
  }

  // Dedup by open_id: return existing key if found
  const isAdminOpenId = openId && ADMIN_OPENIDS.includes(openId)
  const keys = loadKeys()
  if (openId) {
    const existing = keys.find(k => k.openId === openId && !k.revoked)
    if (existing) {
      // Upgrade existing key to admin if openid matches admin whitelist
      if (isAdminOpenId && !existing.admin) {
        existing.admin = true
        saveKeys(keys)
        console.log(`[register] upgraded key "${existing.name}" to admin (open_id match)`)
      }
      console.log(`[register] returning existing key "${existing.name}" for open_id ${openId.slice(0, 8)}...`)
      return c.json({ key: existing.key, name: existing.name, id: existing.id }, 200)
    }
  }

  const key = crypto.randomBytes(32).toString('hex')
  const id = `key_${Date.now()}`
  const name = `user_${id.slice(-6)}`
  keys.push({ id, key, name, openId, created: Date.now(), revoked: false, admin: !!isAdminOpenId })
  saveKeys(keys)
  const rec = regAttempts.get(ip) || { count: 0, lastAttempt: 0 }
  rec.count++; rec.lastAttempt = Date.now()
  regAttempts.set(ip, rec)
  console.log(`[register] created key "${name}" from ${ip}${openId ? ` open_id=${openId.slice(0, 8)}...` : ''}`)
  return c.json({ key, name, id }, 201)
})

// ── WebSocket ──

const ALLOWED_ORIGINS = [
  '', // Allow non-browser clients (no Origin header)
  'https://servicewechat.com',
  'https://developers.weixin.qq.com',
]

app.get('/ws', upgradeWebSocket(() => ({
  onOpen(event, ws) {
    // Validate Origin header
    const headers = event.request?.headers || {}
    const origin = headers.origin || ''
    if (origin && !ALLOWED_ORIGINS.includes(origin) && !origin.startsWith('https://servicewechat.com')) {
      ws.close(4003, 'Forbidden origin')
      return
    }
    // Extract real client IP (behind nginx proxy) for per-IP rate limiting.
    // Without this, all WS connections share ip='' and one client's failures ban everyone.
    const ip = (headers['x-forwarded-for'] || '').split(',')[0].trim()
      || headers['x-real-ip']
      || 'unknown'
    connState.set(ws, { role: null, clientToken: '', hubToken: '', ip, keyId: '' })
  },

  onMessage(event, ws) {
    let msg
    try { msg = JSON.parse(event.data) } catch { return }
    const state = connState.get(ws)
    if (!state) return

    try {
    switch (msg.type) {
      case 'register': {
        if (!isValidKey(msg.key)) {
          ws.send(JSON.stringify({ type: 'register-error', error: 'Invalid key' }))
          ws.close(4001, 'Invalid key')
          return
        }
        state.role = 'hub'
        state.keyId = msg.key

        if (msg.sessionToken && hubs.has(msg.sessionToken)) {
          const e = hubs.get(msg.sessionToken)
          e.ws = ws
          state.hubToken = msg.sessionToken
          ws.send(JSON.stringify({
            type: 'registered',
            token: e.token || genToken(),
            sessionToken: msg.sessionToken,
            reconnected: true,
          }))
          return
        }

        const token = genToken()
        const st = genToken()
        const clientsForHub = new Set()
        // Migrate orphaned clients from previous hub with same keyId
        for (const [, client] of clients) {
          if (client.hubToken === msg.sessionToken) {
            client.hubToken = st
            clientsForHub.add(client.ws)
            try { client.ws.send(JSON.stringify({ type: 'paired', sessionToken: st, clientToken: client.clientToken, reconnected: true })) } catch {}
          }
        }
        hubs.set(st, {
          ws, token, tokenExpires: Date.now() + PAIR_CODE_TTL,
          sessionToken: st, clients: clientsForHub, lastSeen: Date.now(), keyId: msg.key,
        })
        pendingPairs.set(token, st)
        state.hubToken = st
        ws.send(JSON.stringify({ type: 'registered', token, sessionToken: st, reconnected: !!msg.sessionToken }))
        break
      }

      case 'pair': {
        state.role = 'client'
        console.log(`[relay] pair: key=${(msg.key || '').slice(0, 8)} ct=${(msg.clientToken || '').slice(0, 8)} st=${(msg.sessionToken || '').slice(0, 8)} hubs=${hubs.size}`)
        // 1. Rate limit — per real IP (set in onOpen)
        if (!checkRateLimit(state.ip)) {
          ws.send(JSON.stringify({ type: 'pair-error', code: 'rate_limited', error: '尝试过于频繁，请 5 分钟后重试' }))
          return
        }
        const ct = msg.clientToken || genToken()
        // 2. Reconnect with existing clientToken
        if (ct && clients.has(ct)) {
          const e = clients.get(ct)
          if (e.hubToken && hubs.has(e.hubToken)) {
            const hub = hubs.get(e.hubToken)
            hub.clients.delete(e.ws); hub.clients.add(ws)
            e.ws = ws; state.clientToken = ct; state.hubToken = e.hubToken
            ws.send(JSON.stringify({ type: 'paired', sessionToken: e.hubToken, clientToken: ct, reconnected: true }))
            return
          }
          clients.delete(ct)
        }
        // 3. Reconnect with sessionToken (clientToken lost but hub still online)
        if (msg.sessionToken && hubs.has(msg.sessionToken)) {
          const hub = hubs.get(msg.sessionToken)
          clients.set(ct, { ws, hubToken: msg.sessionToken, clientToken: ct })
          hub.clients.add(ws); state.clientToken = ct; state.hubToken = msg.sessionToken
          ws.send(JSON.stringify({ type: 'paired', sessionToken: msg.sessionToken, clientToken: ct, reconnected: true }))
          return
        }
        // 4. Pair by key: find hub with matching keyId
        const pairKey = String(msg.key || '').trim()
        if (pairKey && isValidKey(pairKey)) {
          let matchedHub = null
          for (const [, hub] of hubs) {
            if (hub.keyId === pairKey) { matchedHub = hub; break }
          }
          if (matchedHub) {
            clients.set(ct, { ws, hubToken: matchedHub.sessionToken, clientToken: ct })
            matchedHub.clients.add(ws); state.clientToken = ct; state.hubToken = matchedHub.sessionToken
            ws.send(JSON.stringify({ type: 'paired', sessionToken: matchedHub.sessionToken, clientToken: ct }))
            try { matchedHub.ws.send(JSON.stringify({ type: 'client-connected' })) } catch {}
            const keys = loadKeys()
            const ki = keys.findIndex(k => k.key === pairKey)
            if (ki >= 0) { keys[ki].lastPairedAt = Date.now(); saveKeys(keys) }
            break
          }
          // Valid key, but no hub online — normal transient (user hasn't run codepocket yet).
          // Do NOT recordFail: this is an expected waiting state, not abuse.
          ws.send(JSON.stringify({
            type: 'pair-error',
            code: 'hub_offline',
            error: '电脑尚未连接，请在电脑上执行: codepocket --key ' + pairKey.slice(0, 12) + '...',
          }))
          return
        }
        // 5. Legacy: pair by token (old clients without key)
        const token = String(msg.token || '').trim()
        if (token) {
          const hubId = pendingPairs.get(token)
          if (hubId) {
            const hub = hubs.get(hubId)
            if (hub) {
              clients.set(ct, { ws, hubToken: hub.sessionToken, clientToken: ct })
              hub.clients.add(ws); state.clientToken = ct; state.hubToken = hub.sessionToken
              pendingPairs.delete(token); hub.token = ''
              ws.send(JSON.stringify({ type: 'paired', sessionToken: hub.sessionToken, clientToken: ct }))
              try { hub.ws.send(JSON.stringify({ type: 'client-connected' })) } catch {}
              break
            }
          }
        }
        // 6. No valid key, no valid token — record fail (guards against brute force / probing)
        recordFail(state.ip)
        ws.send(JSON.stringify({
          type: 'pair-error',
          code: 'invalid_key',
          error: pairKey ? 'Key 无效或已吊销，请在小程序重新申请' : '缺少 Key，请在小程序完成配对',
        }))
        return
      }

      case 'sse-event': {
        const hub = getHub(ws); if (!hub) return
        hub.lastSeen = Date.now()
        const p = JSON.stringify({ type: 'sse-event', event: msg.event })
        for (const c of hub.clients) try { c.send(p) } catch {}
        break
      }

      case 'rest-response': {
        const p = pendingRestRequests.get(msg.requestId)
        if (p) { pendingRestRequests.delete(msg.requestId); try { p.ws.send(JSON.stringify(msg)) } catch {} }
        break
      }

      case 'auth-response': {
        const p = pendingAuthRequests.get(msg.requestId)
        if (p) { pendingAuthRequests.delete(msg.requestId); try { p.ws.send(JSON.stringify(msg)) } catch {} }
        break
      }

      case 'phone-action': {
        const hub = getHub(ws); if (!hub) return
        const payload = JSON.stringify(msg)
        for (const c of hub.clients) try { c.send(payload) } catch {}
        pendingPhoneActions.set(msg.actionId, { ws, expires: Date.now() + (msg.timeout || 60000) })
        break
      }

      case 'phone-action-response': {
        const pending = pendingPhoneActions.get(msg.actionId)
        if (pending) { pendingPhoneActions.delete(msg.actionId); try { pending.ws.send(JSON.stringify(msg)) } catch {} }
        break
      }

      case 'spawn-session': {
        const hub = findHubByClient(ws)
        if (!hub) { ws.send(JSON.stringify({ type: 'spawn-session-result', requestId: msg.requestId, success: false, error: 'Hub offline' })); return }
        pendingSpawnRequests.set(msg.requestId, { ws, expires: Date.now() + 60000 })
        try { hub.ws.send(JSON.stringify({ type: 'spawn-session', requestId: msg.requestId, directory: msg.directory })) } catch {
          pendingSpawnRequests.delete(msg.requestId)
          ws.send(JSON.stringify({ type: 'spawn-session-result', requestId: msg.requestId, success: false, error: 'Hub offline' }))
        }
        break
      }

      case 'spawn-session-result': {
        const pending = pendingSpawnRequests.get(msg.requestId)
        if (pending) { pendingSpawnRequests.delete(msg.requestId); try { pending.ws.send(JSON.stringify(msg)) } catch {} }
        break
      }

      case 'resume-session': {
        const hub = findHubByClient(ws)
        if (!hub) { ws.send(JSON.stringify({ type: 'resume-session-result', requestId: msg.requestId, success: false, error: 'Hub offline' })); return }
        pendingResumeRequests.set(msg.requestId, { ws, expires: Date.now() + 60000 })
        try { hub.ws.send(JSON.stringify({ type: 'resume-session', requestId: msg.requestId, sessionId: msg.sessionId })) } catch {
          pendingResumeRequests.delete(msg.requestId)
          ws.send(JSON.stringify({ type: 'resume-session-result', requestId: msg.requestId, success: false, error: 'Hub offline' }))
        }
        break
      }

      case 'resume-session-result': {
        const pending = pendingResumeRequests.get(msg.requestId)
        if (pending) { pendingResumeRequests.delete(msg.requestId); try { pending.ws.send(JSON.stringify(msg)) } catch {} }
        break
      }

      case 'list-dir': {
        const hub = findHubByClient(ws)
        if (!hub) { ws.send(JSON.stringify({ type: 'list-dir-result', requestId: msg.requestId, error: 'Hub offline' })); return }
        pendingListDirRequests.set(msg.requestId, { ws, expires: Date.now() + 15000 })
        try { hub.ws.send(JSON.stringify({ type: 'list-dir', requestId: msg.requestId, path: msg.path || '~' })) } catch {
          pendingListDirRequests.delete(msg.requestId)
          ws.send(JSON.stringify({ type: 'list-dir-result', requestId: msg.requestId, error: 'Hub offline' }))
        }
        break
      }

      case 'list-dir-result': {
        const pending = pendingListDirRequests.get(msg.requestId)
        if (pending) { pendingListDirRequests.delete(msg.requestId); try { pending.ws.send(JSON.stringify(msg)) } catch {} }
        break
      }

      case 'rest-request': {
        const hub = findHubByClient(ws)
        if (!hub) { ws.send(JSON.stringify({ type: 'rest-response', requestId: msg.requestId, status: 503, data: { error: 'Hub offline' } })); return }
        pendingRestRequests.set(msg.requestId, { ws, expires: Date.now() + 60000 })
        try { hub.ws.send(JSON.stringify({ type: 'rest-request', requestId: msg.requestId, method: msg.method, path: msg.path, body: msg.body })) } catch {
          pendingRestRequests.delete(msg.requestId)
          ws.send(JSON.stringify({ type: 'rest-response', requestId: msg.requestId, status: 503, data: { error: 'Hub offline' } }))
        }
        break
      }

      case 'auth-request': {
        const hub = findHubByClient(ws)
        if (!hub) { ws.send(JSON.stringify({ type: 'auth-response', requestId: msg.requestId, ok: false })); return }
        pendingAuthRequests.set(msg.requestId, { ws, expires: Date.now() + 30000 })
        try { hub.ws.send(JSON.stringify({ type: 'auth-request', requestId: msg.requestId, accessToken: msg.accessToken })) } catch {
          ws.send(JSON.stringify({ type: 'auth-response', requestId: msg.requestId, ok: false }))
        }
        break
      }
    }
    } catch (err) {
      console.error('[ws] message handler error:', err.message, err.stack)
    }
  },

  onClose(_, ws) {
    const state = connState.get(ws); if (!state) return
    if (state.role === 'hub' && state.hubToken) setTimeout(() => { const h = hubs.get(state.hubToken); if (h?.ws === ws) cleanupHub(state.hubToken) }, 300000)
    if (state.role === 'client' && state.hubToken) { const h = hubs.get(state.hubToken); if (h) h.clients.delete(ws) }
    connState.delete(ws)
  },
})))

// ── Start ──

const server = serve({ fetch: app.fetch, port: RELAY_PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`[relay] listening on 127.0.0.1:${info.port}`)
  console.log(`[relay] admin: ${ADMIN_KEY.slice(0, 8)}...`)
})
injectWebSocket(server)
