import { Hono } from 'hono'

const app = new Hono()

const HAPI_HUB_URL = (process.env.HAPI_HUB_URL || 'http://127.0.0.1:3006').replace(/\/+$/, '')
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '3010')

type WsClient = { send: (data: string) => void; close: (code?: number, reason?: string) => void }

const connections = new Map<string, {
  ws: WsClient
  sseController: AbortController | null
}>()

// --- SSE to WebSocket bridge ---

async function startSSE(jwt: string, ws: WsClient, sessionId?: string) {
  const controller = new AbortController()
  let url = `${HAPI_HUB_URL}/api/events?all=true`
  if (sessionId) url += `&sessionId=${sessionId}`

  // fire-and-forget: runs in background, cleaned up via controller.abort()
  ;(async () => {
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
      })

      if (!res.ok || !res.body) {
        ws.send(JSON.stringify({ type: 'error', error: `SSE failed: ${res.status}` }))
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data:')) {
            const raw = line.slice(5).trim()
            if (!raw) continue
            try {
              const event = JSON.parse(raw)
              ws.send(JSON.stringify({ type: 'sse-event', event }))
            } catch { /* skip malformed */ }
          }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        ws.send(JSON.stringify({ type: 'error', error: 'SSE stream ended' }))
      }
    }
  })()

  return controller
}

// --- REST proxy helpers ---

function getAuth(c: any) {
  return c.req.header('Authorization')?.replace('Bearer ', '') || ''
}

async function proxyFetch(path: string, token: string, init?: RequestInit) {
  return fetch(`${HAPI_HUB_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
}

async function proxyJson(c: any, path: string, init?: RequestInit) {
  const token = getAuth(c)
  const res = await proxyFetch(path, token, init)
  return c.json(await res.json(), res.status as any)
}

// --- REST routes (proxy to Hub) ---

app.post('/api/auth', async (c) => {
  const body = await c.req.json<{ accessToken: string }>()
  const res = await proxyFetch('/api/auth', '', {
    method: 'POST',
    body: JSON.stringify({ accessToken: body.accessToken }),
  })
  return c.json(await res.json(), res.status as any)
})

app.get('/api/sessions', (c) => proxyJson(c, '/api/sessions'))
app.get('/api/sessions/:id', (c) => proxyJson(c, `/api/sessions/${c.req.param('id')}`))
app.get('/api/sessions/:id/messages', (c) => {
  const qs = new URL(c.req.url).search
  return proxyJson(c, `/api/sessions/${c.req.param('id')}/messages${qs}`)
})
app.post('/api/sessions/:id/messages', async (c) => {
  const body = await c.req.json()
  return proxyJson(c, `/api/sessions/${c.req.param('id')}/messages`, {
    method: 'POST', body: JSON.stringify(body),
  })
})
app.post('/api/sessions/:id/abort', (c) => proxyJson(c, `/api/sessions/${c.req.param('id')}/abort`, { method: 'POST' }))
app.post('/api/sessions/:id/resume', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  return proxyJson(c, `/api/sessions/${c.req.param('id')}/resume`, {
    method: 'POST', body: JSON.stringify(body),
  })
})
app.post('/api/sessions/:id/permissions/:requestId/approve', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  return proxyJson(c, `/api/sessions/${c.req.param('id')}/permissions/${c.req.param('requestId')}/approve`, {
    method: 'POST', body: JSON.stringify(body),
  })
})
app.post('/api/sessions/:id/permissions/:requestId/deny', (c) =>
  proxyJson(c, `/api/sessions/${c.req.param('id')}/permissions/${c.req.param('requestId')}/deny`, {
    method: 'POST', body: JSON.stringify({}),
  }),
)
app.post('/api/sessions/:id/switch', (c) =>
  proxyJson(c, `/api/sessions/${c.req.param('id')}/switch`, { method: 'POST' }),
)

app.get('/', (c) => c.json({ name: 'codepocket-proxy', version: '1.0.0', hub: HAPI_HUB_URL }))

// --- Bun native WebSocket + Hono ---

const server = Bun.serve({
  port: PROXY_PORT,
  fetch(req, server) {
    const url = new URL(req.url)

    if (url.pathname === '/ws' && req.headers.get('upgrade') === 'websocket') {
      server.upgrade(req)
      return
    }

    return app.fetch(req)
  },
  websocket: {
    open(ws) {
      const connId = crypto.randomUUID()
      ws.data = { connId }
      connections.set(connId, { ws, sseController: null })
      ws.send(JSON.stringify({ type: 'connected', connId }))
    },
    async message(ws, raw) {
      if (typeof raw !== 'string') return
      let msg: any
      try { msg = JSON.parse(raw) } catch { return }

      const { connId } = ws.data as { connId: string }

      if (msg.type === 'auth') {
        const conn = connections.get(connId)
        if (!conn) return

        const authRes = await fetch(`${HAPI_HUB_URL}/api/auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken: msg.accessToken }),
        })
        const authData = await authRes.json()

        if (!authRes.ok) {
          ws.send(JSON.stringify({ type: 'auth-error', error: authData.error }))
          return
        }

        ws.send(JSON.stringify({ type: 'auth-ok', token: authData.token, user: authData.user }))

        conn.sseController?.abort()
        conn.sseController = await startSSE(authData.token, ws as any, msg.sessionId)
      }
    },
    close(ws) {
      const { connId } = ws.data as { connId: string }
      const conn = connections.get(connId)
      if (conn) {
        conn.sseController?.abort()
        connections.delete(connId)
      }
    },
  },
})

console.log(`[proxy] listening on :${PROXY_PORT} → ${HAPI_HUB_URL}`)
