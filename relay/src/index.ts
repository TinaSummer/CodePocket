/**
 * CodePocket Relay — 共享中继服务器
 *
 * 安全机制:
 *   - RELAY_KEY: hub 注册密钥，connector 必须提供才能注册
 *   - 配对码 10 分钟过期
 *   - session token 验证所有后续消息
 *   - 未认证连接只允许 pair 操作
 */

import { Hono } from 'hono'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const app = new Hono()

const RELAY_PORT = parseInt(process.env.RELAY_PORT || '3010')
const RELAY_KEY_RAW = process.env.RELAY_KEYS || process.env.RELAY_KEY || ''
const WX_APPID = process.env.WX_APPID || ''
const WX_SECRET = process.env.WX_SECRET || ''
const DATA_DIR = process.env.DATA_DIR || '/opt/codepocket-relay/data'

// ── COS config (optional, for share links) ──
const COS_SECRET_ID = process.env.COS_SECRET_ID || ''
const COS_SECRET_KEY = process.env.COS_SECRET_KEY || ''
const COS_REGION = process.env.COS_REGION || 'ap-shanghai'
const COS_BUCKET = process.env.COS_BUCKET || ''
const COS_BUCKET_URL = process.env.COS_BUCKET_URL || (COS_BUCKET ? `https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com` : '')
const KEYS_FILE = join(DATA_DIR, 'keys.json')
const PAIR_CODE_TTL = 10 * 60 * 1000

// Support multiple keys: comma-separated in RELAY_KEYS, or single RELAY_KEY
const VALID_KEYS = new Set(RELAY_KEY_RAW.split(',').map(k => k.trim()).filter(Boolean))

if (VALID_KEYS.size === 0) {
  console.error('[!] 必须设置 RELAY_KEYS 环境变量 (多个用逗号分隔)')
  console.error('    生成方式: openssl rand -hex 32')
  process.exit(1)
}

console.log(`[relay] loaded ${VALID_KEYS.size} key(s)`)

// ── Persistent Key Management ──

function loadKeys(): any[] {
  try {
    return JSON.parse(readFileSync(KEYS_FILE, 'utf-8'))
  } catch {
    return []
  }
}

function saveKeys(keys: any[]) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2))
}

interface HubConnection {
  ws: any
  token: string
  tokenExpires: number
  sessionToken: string
  clients: Set<any>
  lastSeen: number
  keyId: string  // which key registered this hub
}

interface ClientConnection {
  ws: any
  hubToken: string | null
  clientToken: string
}

const pendingPairs = new Map<string, string>()
const hubs = new Map<string, HubConnection>()
const clients = new Map<string, ClientConnection>()
const pendingRestRequests = new Map<string, { ws: any; expires: number }>()
const pendingAuthRequests = new Map<string, { ws: any; expires: number }>()
const pendingPhoneActions = new Map<string, { ws: any; expires: number }>()
const pendingSpawnRequests = new Map<string, { ws: any; expires: number }>()
const pendingResumeRequests = new Map<string, { ws: any; expires: number }>()
const pendingListDirRequests = new Map<string, { ws: any; expires: number }>()

// Rate limiting: track failed attempts per IP
const failedAttempts = new Map<string, { count: number; lastAttempt: number }>()
const MAX_FAILED_ATTEMPTS = 10
const FAILED_WINDOW = 5 * 60 * 1000 // 5 minutes

// Registration rate limiting
const regAttempts = new Map<string, { count: number; lastAttempt: number }>()
const MAX_REG = 5
const REG_WINDOW = 60 * 60 * 1000 // 1 hour

function genToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')
}

function checkRateLimit(ip: string): boolean {
  const record = failedAttempts.get(ip)
  if (!record) return true
  if (Date.now() - record.lastAttempt > FAILED_WINDOW) {
    failedAttempts.delete(ip)
    return true
  }
  return record.count < MAX_FAILED_ATTEMPTS
}

function recordFailedAttempt(ip: string) {
  const record = failedAttempts.get(ip) || { count: 0, lastAttempt: 0 }
  record.count++
  record.lastAttempt = Date.now()
  failedAttempts.set(ip, record)
}

function findHubByClient(ws: any): HubConnection | null {
  const ct = ws.data?.clientToken
  const client = clients.get(ct)
  if (!client) {
    console.log(`[relay] findHubByClient: no client for token=${ct?.slice(0,8)} hubs=${hubs.size} clients=${clients.size}`)
    return null
  }
  if (!client.hubToken) {
    console.log(`[relay] findHubByClient: client has no hubToken`)
    return null
  }
  const hub = hubs.get(client.hubToken)
  if (!hub) {
    console.log(`[relay] findHubByClient: hub not found for hubToken=${client.hubToken.slice(0,8)} hubs=${hubs.size}`)
  }
  return hub || null
}

function cleanupHub(token: string) {
  const hub = hubs.get(token)
  if (!hub) return
  for (const cws of hub.clients) {
    const client = clients.get(cws.data?.clientToken)
    if (client) client.hubToken = null
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
  for (const [ip, r] of failedAttempts) { if (now - r.lastAttempt > FAILED_WINDOW) failedAttempts.delete(ip) }
  for (const [ip, r] of regAttempts) { if (now - r.lastAttempt > REG_WINDOW) regAttempts.delete(ip) }
}, 60_000)

app.get('/', (c) => c.json({
  name: 'codepocket-relay',
  version: '2.0.0',
  connections: { hubs: hubs.size, clients: clients.size },
}))

app.get('/api/pair-stats', (c) => {
  const keys = loadKeys()
  const paired = keys.filter((k: any) => k.lastPairedAt)
  return c.json({
    totalKeys: keys.length,
    pairedAtLeastOnce: paired.length,
    neverPaired: keys.length - paired.length,
    users: keys.map((k: any) => ({
      name: k.name,
      paired: !!k.lastPairedAt,
      lastPairedAt: k.lastPairedAt || null,
      created: k.created,
    })),
  })
})

// ── Admin API (auth by VALID_KEYS) ──

function isAdminKey(key: string): boolean {
  // Timing-safe comparison against all valid keys
  for (const vk of VALID_KEYS) {
    if (vk.length === key.length && timingSafeEqual(vk, key)) return true
  }
  return false
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const bufA = new TextEncoder().encode(a)
  const bufB = new TextEncoder().encode(b)
  let result = 0
  for (let i = 0; i < bufA.length; i++) result |= bufA[i] ^ bufB[i]
  return result === 0
}

function isValidRelayKey(key: string): boolean {
  for (const vk of VALID_KEYS) {
    if (vk.length === key.length && timingSafeEqual(vk, key)) return true
  }
  return false
}

app.post('/register/admin/check', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  return c.json({ isAdmin: isAdminKey(String(body.key || '')) })
})

app.post('/register/admin/keys', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  if (!isAdminKey(String(body.key || ''))) return c.json({ error: 'Unauthorized' }, 401)
  const keys = loadKeys()
  return c.json({ keys: keys.map((k: any) => ({
    id: k.id, name: k.name, created: k.created,
    paired: !!k.lastPairedAt, lastPairedAt: k.lastPairedAt || null,
    revoked: !!k.revoked, revokedAt: k.revokedAt || null,
  })) })
})

app.post('/register/admin/revoke', async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  if (!isAdminKey(String(body.key || ''))) return c.json({ error: 'Unauthorized' }, 401)

  const { id } = body
  if (!id) return c.json({ error: 'Provide id' }, 400)

  const keys = loadKeys()
  const target = keys.find((k: any) => k.id === id)
  if (!target) return c.json({ error: 'Key not found' }, 404)
  if (target.revoked) return c.json({ error: 'Already revoked' }, 200)

  target.revoked = true
  target.revokedAt = Date.now()
  saveKeys(keys)
  console.log(`[admin] revoked key "${target.name}" (id=${target.id})`)
  return c.json({ ok: true, name: target.name, id: target.id })
})

// ── Share: upload conversation JSON to COS ──

let _cosClient: any = null

function cosClient() {
  if (!COS_SECRET_ID) return null
  if (!_cosClient) {
    const COS = require('cos-nodejs-sdk-v5')
    _cosClient = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY })
  }
  return _cosClient
}

app.post('/share', async (c) => {
  const cos = cosClient()
  if (!cos) return c.json({ error: 'COS not configured' }, 503)

  const body = await c.req.json().catch(() => null) as any
  if (!body || !body.name || !body.messages) {
    return c.json({ error: 'missing name or messages' }, 400)
  }
  if (!Array.isArray(body.messages) || body.messages.length > 500) {
    return c.json({ error: 'messages must be an array with at most 500 items' }, 400)
  }

  const id = crypto.randomUUID().slice(0, 12)
  const key = `shares/${id}.json`

  try {
    await new Promise<void>((resolve, reject) => {
      cos.putObject({
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Key: key,
        Body: JSON.stringify({ name: body.name, agent: body.agent || 'Claude', messages: body.messages }),
        ContentType: 'application/json',
        ACL: 'public-read',
      }, (err: any) => err ? reject(err) : resolve())
    })

    const url = `${COS_BUCKET_URL}/${key}`
    console.log(`[share] uploaded ${id}, ${body.messages.length} messages`)
    return c.json({ id, url })
  } catch (e: any) {
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
    const data = await new Promise<string>((resolve, reject) => {
      cos.getObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: key }, (err: any, res: any) => {
        if (err) reject(err)
        else resolve(res.Body.toString())
      })
    })
    return c.json(JSON.parse(data))
  } catch {
    return c.json({ error: 'not found' }, 404)
  }
})

// ── Public Registration ──

async function getOpenId(code: string): Promise<string | null> {
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${WX_APPID}&secret=${WX_SECRET}&js_code=${code}&grant_type=authorization_code`
  const res = await fetch(url)
  const data = await res.json() as any
  return data.openid || null
}

app.post('/register', async (c) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown'
  const r = regAttempts.get(ip)
  if (r && Date.now() - r.lastAttempt <= REG_WINDOW && r.count >= MAX_REG) {
    return c.json({ error: 'Too many registrations, try again later' }, 429)
  }

  const body = await c.req.json().catch(() => ({})) as any
  let openId = ''
  if (body.code && WX_APPID && WX_SECRET) {
    openId = (await getOpenId(body.code)) || ''
    if (!openId) {
      return c.json({ error: 'Invalid WeChat code' }, 400)
    }
  }

  const keys = loadKeys()
  if (openId) {
    const existing = keys.find(k => (k as any).openId === openId && !k.revoked)
    if (existing) {
      console.log(`[register] returning existing key "${existing.name}" for open_id ${openId.slice(0, 8)}...`)
      return c.json({ key: existing.key, name: existing.name, id: existing.id }, 200)
    }
    // openId found but key revoked — will generate new key below
  }

  const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')
  const id = `key_${Date.now()}`
  const name = `user_${id.slice(-6)}`
  keys.push({ id, key, name, openId, created: Date.now(), revoked: false })
  saveKeys(keys)
  const rec = regAttempts.get(ip) || { count: 0, lastAttempt: 0 }
  rec.count++; rec.lastAttempt = Date.now()
  regAttempts.set(ip, rec)
  console.log(`[register] created key "${name}" from ${ip}${openId ? ` open_id=${openId.slice(0, 8)}...` : ''}`)
  return c.json({ key, name, id }, 201)
})

const ALLOWED_ORIGINS = new Set([
  '', // Allow non-browser clients (no Origin header)
  'https://servicewechat.com',
  'https://developers.weixin.qq.com',
])

const server = Bun.serve({
  port: RELAY_PORT,
  hostname: '127.0.0.1',
  fetch(req, srv) {
    // Validate Origin on WebSocket upgrade
    if (new URL(req.url).pathname === '/ws' && req.headers.get('upgrade') === 'websocket') {
      const origin = req.headers.get('origin') || ''
      if (origin && !ALLOWED_ORIGINS.has(origin) && !origin.startsWith('https://servicewechat.com')) {
        return new Response('Forbidden', { status: 403 })
      }
      srv.upgrade(req)
      return
    }
    return app.fetch(req)
  },
  websocket: {
    idleTimeout: 300,

    open(ws) {
      ws.data = { id: crypto.randomUUID(), role: null as any, clientToken: '', hubToken: '', ip: '' }
    },

    message(ws, raw) {
      if (typeof raw !== 'string') return
      let msg: any
      try { msg = JSON.parse(raw) } catch { return }

      switch (msg.type) {
        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong' }))
          break
        }
        // ── Hub 注册 (需要 RELAY_KEY) ──
        case 'register': {
          // Verify relay key: check both env VALID_KEYS and registered keys in keys.json
          const regKeys = loadKeys()
          const isRegisteredKey = regKeys.some(k => k.key === msg.key && !k.revoked)
          if (!isValidRelayKey(msg.key) && !isRegisteredKey) {
            ws.send(JSON.stringify({ type: 'register-error', error: 'Invalid key' }))
            ws.close(4001, 'Invalid key')
            return
          }

          ws.data.role = 'hub'
          ws.data.keyId = msg.key

          // Reconnect existing session
          if (msg.sessionToken && hubs.has(msg.sessionToken)) {
            const existing = hubs.get(msg.sessionToken)!
            existing.ws = ws
            ws.data.hubToken = msg.sessionToken
            ws.send(JSON.stringify({
              type: 'registered',
              token: existing.token || genToken(),
              sessionToken: msg.sessionToken,
              reconnected: true,
            }))
            return
          }

          const token = genToken()
          const st = genToken()
          const clientsForHub = new Set<any>()
          // Migrate orphaned clients from previous hub with same keyId
          for (const [, client] of clients) {
            if (client.hubToken === msg.sessionToken) {
              client.hubToken = st
              clientsForHub.add(client.ws)
              try { client.ws.send(JSON.stringify({ type: 'paired', sessionToken: st, clientToken: client.clientToken, reconnected: true })) } catch {}
            }
          }
          hubs.set(st, { ws, token, tokenExpires: Date.now() + PAIR_CODE_TTL, sessionToken: st, clients: clientsForHub, lastSeen: Date.now(), keyId: msg.key })
          pendingPairs.set(token, st)
          ws.data.hubToken = st
          ws.send(JSON.stringify({ type: 'registered', token, sessionToken: st, reconnected: msg.sessionToken ? true : false }))
          break
        }

        // ── 客户端配对 ──
        case 'pair': {
          ws.data.role = 'client'

          // Rate limit check
          if (!checkRateLimit(ws.data.ip || 'unknown')) {
            ws.send(JSON.stringify({ type: 'pair-error', error: 'Too many attempts, try again later' }))
            return
          }

          const ct = msg.clientToken || genToken()

          // Reconnect existing client — only if hub still alive
          if (ct && clients.has(ct)) {
            const existing = clients.get(ct)!
            if (existing.hubToken && hubs.has(existing.hubToken)) {
              const hub = hubs.get(existing.hubToken)!
              hub.clients.delete(existing.ws)
              hub.clients.add(ws)
              existing.ws = ws
              ws.data.clientToken = ct
              ws.send(JSON.stringify({ type: 'paired', sessionToken: existing.hubToken, clientToken: ct, reconnected: true }))
              return
            }
            // Hub gone — remove stale client entry and fall through
            clients.delete(ct)
          }

          // Reconnect with sessionToken (clientToken lost but hub still online)
          if (msg.sessionToken && hubs.has(msg.sessionToken)) {
            const hub = hubs.get(msg.sessionToken)!
            clients.set(ct, { ws, hubToken: msg.sessionToken, clientToken: ct })
            hub.clients.add(ws)
            ws.data.clientToken = ct
            ws.data.hubToken = msg.sessionToken
            ws.send(JSON.stringify({ type: 'paired', sessionToken: msg.sessionToken, clientToken: ct, reconnected: true }))
            return
          }

          // Pair by key: find hub with matching keyId
          const pairKey = String(msg.key || '').trim()
          const pairRegistered = loadKeys().some(k => k.key === pairKey && !k.revoked)
          if (pairKey && (isValidRelayKey(pairKey) || pairRegistered)) {
            let matchedHub: HubConnection | null = null
            for (const [, hub] of hubs) {
              if (hub.keyId === pairKey) { matchedHub = hub; break }
            }
            if (matchedHub) {
              clients.set(ct, { ws, hubToken: matchedHub.sessionToken, clientToken: ct })
              matchedHub.clients.add(ws)
              ws.data.clientToken = ct
              ws.data.hubToken = matchedHub.sessionToken
              ws.send(JSON.stringify({ type: 'paired', sessionToken: matchedHub.sessionToken, clientToken: ct }))
              try { matchedHub.ws.send(JSON.stringify({ type: 'client-connected' })) } catch {}
              // Record pairing time on the key
              const keys = loadKeys()
              const ki = keys.findIndex((k: any) => k.key === pairKey)
              if (ki >= 0) { keys[ki].lastPairedAt = Date.now(); saveKeys(keys) }
              break
            }
          }

          const token = String(msg.token || '').trim()
          const hubId = pendingPairs.get(token)
          if (!hubId) {
            recordFailedAttempt(ws.data.ip || 'unknown')
            ws.send(JSON.stringify({ type: 'pair-error', error: '配对码无效或已过期' }))
            return
          }

          const hub = hubs.get(hubId)
          if (!hub) {
            ws.send(JSON.stringify({ type: 'pair-error', error: 'Hub 不在线' }))
            return
          }

          clients.set(ct, { ws, hubToken: hub.sessionToken, clientToken: ct })
          hub.clients.add(ws)
          ws.data.clientToken = ct
          pendingPairs.delete(token)
          hub.token = ''

          ws.send(JSON.stringify({ type: 'paired', sessionToken: hub.sessionToken }))
          try { hub.ws.send(JSON.stringify({ type: 'client-connected' })) } catch {}
          break
        }

        // ── Hub → Clients: SSE event ──
        case 'sse-event': {
          const hub = hubs.get(ws.data.hubToken)
          if (!hub) return
          hub.lastSeen = Date.now()
          const payload = JSON.stringify({ type: 'sse-event', event: msg.event })
          for (const cws of hub.clients) try { cws.send(payload) } catch {}
          break
        }

        // ── Hub → Client: REST/auth response ──
        case 'rest-response': {
          const pending = pendingRestRequests.get(msg.requestId)
          if (pending) {
            pendingRestRequests.delete(msg.requestId)
            try { pending.ws.send(JSON.stringify(msg)) } catch {}
          }
          break
        }

        case 'auth-response': {
          const pending = pendingAuthRequests.get(msg.requestId)
          if (pending) {
            pendingAuthRequests.delete(msg.requestId)
            try { pending.ws.send(JSON.stringify(msg)) } catch {}
          }
          break
        }

        // ── Hub → Clients: Phone action ──
        case 'phone-action': {
          const hub = hubs.get(ws.data.hubToken)
          if (!hub) return
          const payload = JSON.stringify(msg)
          for (const cws of hub.clients) try { cws.send(payload) } catch {}
          pendingPhoneActions.set(msg.actionId, { ws, expires: Date.now() + (msg.timeout || 60000) })
          break
        }

        // ── Client → Hub: REST request ──
        case 'rest-request': {
          const hub = findHubByClient(ws)
          if (!hub) {
            ws.send(JSON.stringify({ type: 'rest-response', requestId: msg.requestId, status: 503, data: { error: 'Hub offline' } }))
            return
          }
          pendingRestRequests.set(msg.requestId, { ws, expires: Date.now() + 30_000 })
          try {
            hub.ws.send(JSON.stringify({ type: 'rest-request', requestId: msg.requestId, method: msg.method, path: msg.path, body: msg.body }))
          } catch {
            pendingRestRequests.delete(msg.requestId)
            ws.send(JSON.stringify({ type: 'rest-response', requestId: msg.requestId, status: 503, data: { error: 'Hub offline' } }))
          }
          break
        }

        // ── Client → Hub: auth request ──
        case 'auth-request': {
          const hub = findHubByClient(ws)
          if (!hub) {
            ws.send(JSON.stringify({ type: 'auth-response', requestId: msg.requestId, ok: false, data: { error: 'Hub offline' } }))
            return
          }
          pendingAuthRequests.set(msg.requestId, { ws, expires: Date.now() + 30_000 })
          try {
            hub.ws.send(JSON.stringify({ type: 'auth-request', requestId: msg.requestId, accessToken: msg.accessToken }))
          } catch {
            ws.send(JSON.stringify({ type: 'auth-response', requestId: msg.requestId, ok: false, data: { error: 'Hub offline' } }))
          }
          break
        }

        // ── Client → Hub: Phone action response ──
        case 'phone-action-response': {
          const pending = pendingPhoneActions.get(msg.actionId)
          if (pending) {
            pendingPhoneActions.delete(msg.actionId)
            try { pending.ws.send(JSON.stringify(msg)) } catch {}
          }
          break
        }

        // ── Client → Hub: Spawn new session ──
        case 'spawn-session': {
          const hub = findHubByClient(ws)
          if (!hub) {
            ws.send(JSON.stringify({ type: 'spawn-session-result', requestId: msg.requestId, success: false, error: 'Hub offline' }))
            return
          }
          pendingSpawnRequests.set(msg.requestId, { ws, expires: Date.now() + 60_000 })
          try {
            hub.ws.send(JSON.stringify({ type: 'spawn-session', requestId: msg.requestId, directory: msg.directory }))
          } catch {
            pendingSpawnRequests.delete(msg.requestId)
            ws.send(JSON.stringify({ type: 'spawn-session-result', requestId: msg.requestId, success: false, error: 'Hub offline' }))
          }
          break
        }

        // ── Hub → Client: Spawn session result ──
        case 'spawn-session-result': {
          const pending = pendingSpawnRequests.get(msg.requestId)
          if (pending) {
            pendingSpawnRequests.delete(msg.requestId)
            try { pending.ws.send(JSON.stringify(msg)) } catch {}
          }
          break
        }

        // ── Client → Hub: Resume session ──
        case 'resume-session': {
          const hub = findHubByClient(ws)
          if (!hub) {
            ws.send(JSON.stringify({ type: 'resume-session-result', requestId: msg.requestId, success: false, error: 'Hub offline' }))
            return
          }
          pendingResumeRequests.set(msg.requestId, { ws, expires: Date.now() + 60_000 })
          try {
            hub.ws.send(JSON.stringify({ type: 'resume-session', requestId: msg.requestId, sessionId: msg.sessionId }))
          } catch {
            pendingResumeRequests.delete(msg.requestId)
            ws.send(JSON.stringify({ type: 'resume-session-result', requestId: msg.requestId, success: false, error: 'Hub offline' }))
          }
          break
        }

        // ── Hub → Client: Resume session result ──
        case 'resume-session-result': {
          const pending = pendingResumeRequests.get(msg.requestId)
          if (pending) {
            pendingResumeRequests.delete(msg.requestId)
            try { pending.ws.send(JSON.stringify(msg)) } catch {}
          }
          break
        }

        // ── Client → Hub: List directory ──
        case 'list-dir': {
          const hub = findHubByClient(ws)
          if (!hub) {
            ws.send(JSON.stringify({ type: 'list-dir-result', requestId: msg.requestId, error: 'Hub offline' }))
            return
          }
          pendingListDirRequests.set(msg.requestId, { ws, expires: Date.now() + 15_000 })
          try {
            hub.ws.send(JSON.stringify({ type: 'list-dir', requestId: msg.requestId, path: msg.path || '~' }))
          } catch {
            pendingListDirRequests.delete(msg.requestId)
            ws.send(JSON.stringify({ type: 'list-dir-result', requestId: msg.requestId, error: 'Hub offline' }))
          }
          break
        }

        // ── Hub → Client: List directory result ──
        case 'list-dir-result': {
          const pending = pendingListDirRequests.get(msg.requestId)
          if (pending) {
            pendingListDirRequests.delete(msg.requestId)
            try { pending.ws.send(JSON.stringify(msg)) } catch {}
          }
          break
        }
      }
    },

    close(ws) {
      const { role, hubToken } = ws.data
      if (role === 'hub' && hubToken) {
        setTimeout(() => {
          const hub = hubs.get(hubToken)
          if (hub?.ws === ws) cleanupHub(hubToken)
        }, 300_000)
      }
      if (role === 'client') {
        const hub = hubToken ? hubs.get(hubToken) : null
        if (hub) hub.clients.delete(ws)
      }
    },
  },
})

console.log(`[relay] listening on :${RELAY_PORT}`)
console.log(`[relay] keys: ${[...VALID_KEYS].map(k => k.slice(0, 8) + '...').join(', ')}`)
