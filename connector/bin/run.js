#!/usr/bin/env node

/**
 * CodePocket Connector — 一行命令连接小程序
 *
 * 用法:
 *   首次: npx codepocket --key YOUR_KEY
 *   之后: npx codepocket
 *
 * 也可通过环境变量配置:
 *   RELAY_KEY=xxx codepocket
 */

const { WebSocket } = require('ws')
const fs = require('fs')
const path = require('path')
const os = require('os')
const qrcode = require('qrcode-terminal')

// ── Config ──

const CONFIG_DIR = path.join(os.homedir(), '.codepocket', 'hub')
const CONFIG_FILE = path.join(path.join(os.homedir(), '.codepocket'), 'config.json')
const SESSION_FILE = path.join(CONFIG_DIR, 'wechat-session.json')

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) } catch { return {} }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
}

// Parse args
const args = process.argv.slice(2)
let hubUrl = process.env.CPKT_HUB_URL || process.env.HAPI_HUB_URL || 'http://127.0.0.1:3006'
let relayUrl = process.env.RELAY_WS_URL || ''
let relayKey = process.env.RELAY_KEY || ''

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg.startsWith('--hub=')) hubUrl = arg.slice(6).replace(/\/+$/, '')
  if (arg === '--hub' && args[i + 1]) { hubUrl = args[++i].replace(/\/+$/, '') }
  if (arg.startsWith('--relay=')) relayUrl = arg.slice(8)
  if (arg === '--relay' && args[i + 1]) { relayUrl = args[++i] }
  if (arg.startsWith('--key=')) relayKey = arg.slice(6)
  if (arg === '--key' && args[i + 1]) { relayKey = args[++i] }
}

// Load saved config, merge with args
const saved = loadConfig()
if (relayKey) {
  // New key provided — save it
  saveConfig({ ...saved, relayKey, relayUrl: relayUrl || saved.relayUrl || '' })
} else {
  relayKey = saved.relayKey || ''
}
if (!relayUrl) relayUrl = saved.relayUrl || ''

let jwt = ''
let relayWs = null
let relaySessionToken = ''
let sseResponse = null

// ── Find CLI token ──

async function findHubToken() {
  const hubHome = process.env.CODEPOCKET_HOME || path.join(os.homedir(), '.codepocket')
  const settingsPath = path.join(hubHome, 'settings.json')
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    if (settings.cliApiToken) return settings.cliApiToken
  } catch {}
  if (process.env.CLI_API_TOKEN) return process.env.CLI_API_TOKEN
  console.error('[!] 找不到 Hub token，请先运行: cpkt')
  process.exit(1)
}

// ── Authenticate ──

async function authenticateHub(token) {
  const res = await fetch(`${hubUrl}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: token }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(`Hub auth failed: ${data.error || res.status}`)
  }
  return (await res.json()).token
}

// ── SSE stream ──

async function startSSE() {
  const url = `${hubUrl}/api/events?token=${encodeURIComponent(jwt)}&all=true`
  try {
    const res = await fetch(url, { headers: { Accept: 'text/event-stream' } })
    if (!res.ok || !res.body) {
      console.error(`[SSE] failed: ${res.status}, retrying in 5s...`)
      setTimeout(startSSE, 5000)
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    async function pump() {
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
            try { sendToRelay({ type: 'sse-event', event: JSON.parse(raw) }) } catch {}
          }
        }
      }
      console.error('[SSE] stream ended, reconnecting in 5s...')
      setTimeout(startSSE, 5000)
    }
    sseResponse = res
    pump().catch(() => { setTimeout(startSSE, 5000) })
  } catch {
    console.error('[SSE] connection error, retrying in 5s...')
    setTimeout(startSSE, 5000)
  }
}

// ── Relay connection ──

function connectRelay() {
  let savedSession = null
  try { savedSession = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) } catch {}

  relayWs = new WebSocket(relayUrl)

  relayWs.on('open', () => {
    console.log('[Relay] connected')
    relayWs.send(JSON.stringify({
      type: 'register',
      key: relayKey,
      sessionToken: savedSession?.sessionToken || undefined,
    }))
  })

  relayWs.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    handleRelayMessage(msg)
  })

  relayWs.on('close', () => {
    console.log('[Relay] disconnected, reconnecting in 3s...')
    relayWs = null
    setTimeout(connectRelay, 3000)
  })

  relayWs.on('error', () => { relayWs?.close() })
}

function handleRelayMessage(msg) {
  switch (msg.type) {
    case 'registered': {
      relaySessionToken = msg.sessionToken
      try {
        fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true })
        fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionToken: relaySessionToken, hubUrl, relayUrl }))
      } catch {}
      if (msg.reconnected) {
        console.log('\n  [✓] 已重新连接\n')
      } else {
        const qrContent = `codepocket://pair?token=${msg.token}`
        console.log()
        qrcode.generate(qrContent, { small: true }, (qrStr) => {
          console.log(qrStr)
        })
        console.log('  打开小程序 → 扫码连接\n')
      }
      break
    }
    case 'client-connected': {
      console.log('  [✓] 微信小程序已连接')
      break
    }
    case 'rest-request': {
      forwardToHub(msg.requestId, msg.method, msg.path, msg.body)
      break
    }
    case 'auth-request': {
      handleAuthRequest(msg.requestId, msg.accessToken)
      break
    }
    case 'register-error': {
      console.error(`  [!] ${msg.error}`)
      console.error('  请检查 key 是否正确')
      console.error('  请在小程序中查看 Key')
      break
    }
  }
}

function sendToRelay(msg) {
  if (relayWs?.readyState === WebSocket.OPEN) {
    relayWs.send(JSON.stringify(msg))
  }
}

async function forwardToHub(requestId, method, p, body) {
  try {
    const init = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      },
    }
    if (body && method !== 'GET') init.body = JSON.stringify(body)
    const res = await fetch(`${hubUrl}${p}`, init)
    const data = await res.json().catch(() => ({}))
    sendToRelay({ type: 'rest-response', requestId, status: res.status, data })
  } catch (err) {
    sendToRelay({ type: 'rest-response', requestId, status: 502, data: { error: err.message } })
  }
}

async function handleAuthRequest(requestId, accessToken) {
  try {
    const res = await fetch(`${hubUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken }),
    })
    const data = await res.json()
    sendToRelay({ type: 'auth-response', requestId, ok: res.ok, data })
  } catch (err) {
    sendToRelay({ type: 'auth-response', requestId, ok: false, data: { error: err.message } })
  }
}

// ── Main ──

async function main() {
  console.log('╔══════════════════════════════════════╗')
  console.log('║    CodePocket Connect                 ║')
  console.log('╚══════════════════════════════════════╝')
  console.log()

  if (!relayKey) {
    console.error('[!] 需要 relay 密钥（首次使用只需设置一次）')
    console.error()
    console.error('  用法:')
    console.error('    codepocket --key YOUR_KEY')
    console.error()
    console.error('  获取 key:')
    console.error('    在 CodePocket 小程序中获取 Key')
    console.error()
    console.error('  或设置环境变量:')
    console.error('    export RELAY_KEY=xxx')
    console.error()
    process.exit(1)
  }

  console.log(`  Hub:   ${hubUrl}`)
  console.log(`  Relay: ${relayUrl}`)
  console.log(`  Key:   ${relayKey.slice(0, 8)}...`)
  console.log()

  console.log('[1/3] 连接 Hub...')
  const token = await findHubToken()

  console.log('[2/3] 认证中...')
  jwt = await authenticateHub(token)
  console.log('[✓] Hub 认证成功')

  console.log('[3/3] 连接中继服务器...')
  startSSE()
  connectRelay()
}

main().catch((err) => {
  console.error('[!] 启动失败:', err.message)
  process.exit(1)
})
