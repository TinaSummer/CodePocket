/**
 * CodePocket Connector — 在用户机器上运行，桥接本地 Hub 和远程 Relay
 *
 * 用法:
 *   bun run src/index.ts                          # 自动发现本地 hub
 *   bun run src/index.ts --hub http://localhost:3006 --relay wss://relay.example.com/ws
 *
 * 工作流程:
 *   1. 连接本地 Hub REST API，获取 CLI_API_TOKEN
 *   2. 用 token 调用 /api/auth 获取 JWT
 *   3. 开启 SSE 流，接收实时事件
 *   4. 连接远程 Relay WebSocket
 *   5. 注册并获取配对码，显示给用户
 *   6. 双向转发: SSE→Relay, Relay REST→Hub REST
 */

const HUB_URL = (process.env.CPKT_HUB_URL || process.env.HAPI_HUB_URL || 'http://127.0.0.1:3006').replace(/\/+$/, '')
const RELAY_WS = process.env.RELAY_WS_URL || 'ws://127.0.0.1:3010/ws'
const HUB_HOME = process.env.HAPI_HOME || `${process.env.HOME}/.codepocket/hub`
const SESSION_FILE = `${HUB_HOME}/wechat-session.json`

let hubToken = ''       // CLI_API_TOKEN
let jwt = ''            // JWT from hub
let relayWs: any = null
let relaySessionToken = ''
let sseController: AbortController | null = null

// --- Parse args ---
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--hub=')) process.env.HAPI_HUB_URL = arg.slice(6)
  if (arg.startsWith('--relay=')) process.env.RELAY_WS_URL = arg.slice(8)
}

const hubUrl = (process.env.HAPI_HUB_URL || HUB_URL).replace(/\/+$/, '')
const relayUrl = process.env.RELAY_WS_URL || RELAY_WS

// --- Step 1: Find CLI token ---

async function findHubToken(): Promise<string> {
  // Try settings file
  const settingsPath = `${HUB_HOME}/settings.json`
  try {
    const settings = await Bun.file(settingsPath).json()
    if (settings.cliApiToken) return settings.cliApiToken
  } catch {}

  // Try env
  if (process.env.CLI_API_TOKEN) return process.env.CLI_API_TOKEN

  console.error('[!] 无法找到 CLI_API_TOKEN')
  console.error('    请确保 Hub 正在运行，或设置 CLI_API_TOKEN 环境变量')
  process.exit(1)
}

// --- Step 2: Authenticate with hub ---

async function authenticateHub(token: string): Promise<string> {
  const res = await fetch(`${hubUrl}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: token }),
  })

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(`Hub auth failed: ${data.error || res.status}`)
  }

  const data = await res.json()
  return data.token
}

// --- Step 3: Start SSE from hub ---

function startSSE() {
  sseController?.abort()
  sseController = new AbortController()

  const url = `${hubUrl}/api/events?token=${encodeURIComponent(jwt)}&all=true`

  ;(async () => {
    try {
      const res = await fetch(url, {
        signal: sseController!.signal,
        headers: { Accept: 'text/event-stream' },
      })

      if (!res.ok || !res.body) {
        console.error(`[SSE] connection failed: ${res.status}`)
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
              forwardToRelay({ type: 'sse-event', event })
            } catch {}
          }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error('[SSE] stream ended, reconnecting in 5s...')
        setTimeout(startSSE, 5000)
      }
    }
  })()
}

// --- Step 4: Connect to relay ---

function connectRelay() {
  try {
    relayWs = new WebSocket(relayUrl)
  } catch (err) {
    console.error(`[Relay] connect failed, retrying in 5s...`)
    setTimeout(connectRelay, 5000)
    return
  }

  relayWs.onopen = () => {
    console.log('[Relay] connected')

    // Try to reconnect with existing session
    let savedSession: any = null
    try { savedSession = JSON.parse(require('fs').readFileSync(SESSION_FILE, 'utf-8')) } catch {}

    relayWs.send(JSON.stringify({
      type: 'register',
      sessionToken: savedSession?.sessionToken || undefined,
    }))
  }

  relayWs.onmessage = (event: MessageEvent) => {
    let msg: any
    try { msg = JSON.parse(event.data as string) } catch { return }
    handleRelayMessage(msg)
  }

  relayWs.onclose = () => {
    console.log('[Relay] disconnected, reconnecting in 3s...')
    relayWs = null
    setTimeout(connectRelay, 3000)
  }

  relayWs.onerror = () => {
    relayWs?.close()
  }
}

function handleRelayMessage(msg: any) {
  switch (msg.type) {
    case 'registered': {
      relaySessionToken = msg.sessionToken

      // Save session for reconnection
      try {
        require('fs').mkdirSync(require('path').dirname(SESSION_FILE), { recursive: true })
        require('fs').writeFileSync(SESSION_FILE, JSON.stringify({
          sessionToken: relaySessionToken,
          hubUrl,
          relayUrl,
        }))
      } catch {}

      if (msg.reconnected) {
        console.log(`\n[✓] 已重新连接\n`)
      } else {
        console.log(`\n${'═'.repeat(40)}`)
        console.log(`  微信小程序配对码:  ${msg.code}`)
        console.log(`${'═'.repeat(40)}\n`)
        console.log('  打开小程序 → 输入配对码 → 即可连接')
        console.log('  配对码 10 分钟内有效\n')
      }
      break
    }

    case 'client-connected': {
      console.log('[✓] 微信小程序已连接')
      break
    }

    // Client REST request → forward to local hub
    case 'rest-request': {
      forwardToHub(msg.requestId, msg.method, msg.path, msg.body)
      break
    }

    // Client auth request → forward to local hub
    case 'auth-request': {
      handleAuthRequest(msg.requestId, msg.accessToken)
      break
    }
  }
}

// --- Forwarding ---

function forwardToRelay(msg: any) {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) {
    relayWs.send(JSON.stringify(msg))
  }
}

async function forwardToHub(requestId: string, method: string, path: string, body?: any) {
  try {
    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      },
    }
    if (body && method !== 'GET') init.body = JSON.stringify(body)

    const res = await fetch(`${hubUrl}${path}`, init)
    const data = await res.json().catch(() => ({}))

    forwardToRelay({
      type: 'rest-response',
      requestId,
      status: res.status,
      data,
    })
  } catch (err: any) {
    console.error(`[REST] ${method} ${path} failed:`, err.message)
    forwardToRelay({
      type: 'rest-response',
      requestId,
      status: 502,
      data: { error: err.message },
    })
  }
}

async function handleAuthRequest(requestId: string, accessToken: string) {
  try {
    const res = await fetch(`${hubUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken }),
    })
    const data = await res.json()
    forwardToRelay({
      type: 'auth-response',
      requestId,
      ok: res.ok,
      data,
    })
  } catch (err: any) {
    forwardToRelay({
      type: 'auth-response',
      requestId,
      ok: false,
      data: { error: err.message },
    })
  }
}

// --- Main ---

async function main() {
  console.log('╔══════════════════════════════════════╗')
  console.log('║    CodePocket Connector v1.0          ║')
  console.log('╚══════════════════════════════════════╝')
  console.log()
  console.log(`Hub:   ${hubUrl}`)
  console.log(`Relay: ${relayUrl}`)
  console.log()

  // 1. Find token
  console.log('[1/3] 连接 Hub...')
  hubToken = await findHubToken()

  // 2. Authenticate
  console.log('[2/3] 认证中...')
  jwt = await authenticateHub(hubToken)
  console.log('[✓] Hub 认证成功')

  // 3. Start SSE + connect relay
  console.log('[3/3] 连接中继服务器...')
  startSSE()
  connectRelay()
}

main().catch((err) => {
  console.error('[!] 启动失败:', err.message)
  process.exit(1)
})
