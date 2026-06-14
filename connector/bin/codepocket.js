#!/usr/bin/env node

/**
 * CodePocket — 你的全能 AI 随身控制台
 *
 *   npx codepocket          启动 Claude Code + 自动连接手机
 *   npx codepocket --key X  首次配对（保存 Key）
 *   npx cpkt                短命令
 */

const { WebSocket } = require('ws')
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const readline = require('readline')
const { startMcpServer, handlePhoneActionResponse: onPhoneActionResponse } = require('../src/mcp-server')
const { runTestCli } = require('../src/mcp-client')

// ── Config ──

const CONFIG_DIR = path.join(os.homedir(), '.codepocket')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const SESSION_FILE = path.join(CONFIG_DIR, 'session.json')
const HOME_ENV = { CODEPOCKET_HOME: path.join(os.homedir(), '.codepocket') }

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) } catch { return {} }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
}

function injectMcpConfig(port) {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  let settings = {}
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) } catch {}
  if (!settings.mcpServers) settings.mcpServers = {}
  if (settings.mcpServers['codepocket-phone']) return
  settings.mcpServers['codepocket-phone'] = {
    type: 'sse',
    url: `http://127.0.0.1:${port}/sse`,
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

// ── Helpers ──

/**
 * Encode a directory path the same way Claude Code does:
 * resolve() then replace non-alphanumeric with '-'
 */
function encodeProjectPath(dir) {
  return path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Find the Claude Code session ID (.jsonl file) for a given working directory.
 * Tries to match by directory encoding; falls back to most recent valid file.
 */
function findClaudeSessionFile(directory) {
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  const projectId = encodeProjectPath(directory)
  const projectDir = path.join(claudeConfigDir, 'projects', projectId)

  if (!fs.existsSync(projectDir)) return null

  try {
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const filePath = path.join(projectDir, f)
        try {
          const stat = fs.statSync(filePath)
          // Check file has real content (at least one line with uuid)
          const data = fs.readFileSync(filePath, 'utf-8').split('\n')
          const hasContent = data.some(line => {
            try { return typeof JSON.parse(line).uuid === 'string' }
            catch { return false }
          })
          return { name: f.replace('.jsonl', ''), mtime: stat.mtime.getTime(), hasContent }
        } catch { return null }
      })
      .filter(f => f && f.hasContent)
      .sort((a, b) => b.mtime - a.mtime)

    return files.length > 0 ? files[0].name : null
  } catch { return null }
}

function findHubBin() {
  // 1. Platform-specific npm package (e.g. @tina_summer/codepocket-win32-x64)
  const platformTag = `${process.platform}-${process.arch}`
  const platformBinName = process.platform === 'win32' ? 'codepocket.exe' : 'codepocket'
  const platformBin = path.join(__dirname, '..', 'node_modules', `@tina_summer`, `codepocket-${platformTag}`, 'bin', platformBinName)
  if (fs.existsSync(platformBin)) return platformBin

  // 2. Bundled vendor binary
  const vendorBinName = process.platform === 'win32' ? 'cpkt-hub.exe' : 'cpkt-hub'
  const bundledBin = path.join(__dirname, '..', 'vendor', vendorBinName)
  if (fs.existsSync(bundledBin)) return bundledBin

  // 3. System PATH
  const cmd = process.platform === 'win32' ? 'where codepocket' : 'which codepocket 2>/dev/null'
  try { const r = execSync(cmd).toString().trim().split(/\r?\n/)[0]; if (r) return r } catch {}
  const cmd2 = process.platform === 'win32' ? 'where cpkt-hub' : 'which cpkt-hub 2>/dev/null'
  try { const r = execSync(cmd2).toString().trim().split(/\r?\n/)[0]; if (r) return r } catch {}
  return null
}

async function isHubRunning(hubUrl) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    const res = await fetch(`${hubUrl}/api/sessions`, { signal: controller.signal })
    clearTimeout(timer)
    return res.status > 0 // Any HTTP response means hub is up
  } catch { return false }
}

// ── Parse args ──

const args = process.argv.slice(2)

// 'test' subcommand — standalone
if (args[0] === 'test') {
  runTestCli(args.slice(1))
  return
}

// ── Background mode helpers ──

const PID_FILE = path.join(CONFIG_DIR, 'codepocket.pid')
const LOG_DIR = path.join(CONFIG_DIR, 'logs')

function getLogFile() {
  const d = new Date()
  const ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return path.join(LOG_DIR, `${ts}.log`)
}

function checkRunning() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim())
    if (pid && process.kill(pid, 0)) return pid
  } catch {}
  try { fs.unlinkSync(PID_FILE) } catch {}
  return 0
}

// 'stop' subcommand
if (args[0] === 'stop') {
  const pid = checkRunning()
  if (!pid) {
    console.log('[codepocket] Not running')
    process.exit(0)
  }
  try { process.kill(pid, process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM') } catch {}
  try { fs.unlinkSync(PID_FILE) } catch {}
  console.log(`[codepocket] Stopped (PID ${pid})`)
  process.exit(0)
}

// 'logs' subcommand
if (args[0] === 'logs') {
  const logFile = getLogFile()
  if (!fs.existsSync(logFile)) {
    console.log('[codepocket] No log file for today')
    process.exit(1)
  }
  const lines = parseInt(args[1]) || 50
  try {
    if (process.platform === 'win32') {
      // Windows: read last N lines and keep watching
      const content = fs.readFileSync(logFile, 'utf-8').split('\n').slice(-lines).join('\n')
      process.stdout.write(content)
      const watcher = fs.watch(logFile, () => {
        try {
          const updated = fs.readFileSync(logFile, 'utf-8').split('\n').slice(-1)[0]
          process.stdout.write(updated + '\n')
        } catch {}
      })
      process.on('SIGINT', () => { watcher.close(); process.exit(0) })
    } else {
      spawn('tail', ['-n', String(lines), '-f', logFile], { stdio: 'inherit' })
    }
  } catch {}
  process.exit(0)
}

// 'status' subcommand
if (args[0] === 'status') {
  const pid = checkRunning()
  if (pid) {
    console.log(`[codepocket] Running (PID ${pid})`)
  } else {
    console.log('[codepocket] Not running')
  }
  process.exit(0)
}

// Determine mode
const CONNECT_ONLY = ['connect', 'c'].includes(args[0])
const filteredArgs = CONNECT_ONLY ? args.slice(1) : args

let hubUrl = process.env.CPKT_HUB_URL || process.env.HAPI_HUB_URL || 'http://127.0.0.1:3006'
const DEFAULT_RELAY_URL = ''
let relayUrl = process.env.RELAY_WS_URL || process.env.RELAY_URL || DEFAULT_RELAY_URL
let relayKey = process.env.RELAY_KEY || ''
let noHub = false

const passThroughArgs = []
for (let i = 0; i < filteredArgs.length; i++) {
  const arg = filteredArgs[i]
  if (arg.startsWith('--hub=')) hubUrl = arg.slice(6).replace(/\/+$/, '')
  else if (arg === '--hub' && filteredArgs[i + 1]) { hubUrl = filteredArgs[++i].replace(/\/+$/, '') }
  else if (arg.startsWith('--relay=')) relayUrl = arg.slice(8)
  else if (arg === '--relay' && filteredArgs[i + 1]) { relayUrl = filteredArgs[++i] }
  else if (arg.startsWith('--key=')) relayKey = arg.slice(6)
  else if (arg === '--key' && filteredArgs[i + 1]) { relayKey = filteredArgs[++i] }
  else if (arg === '--no-hub') noHub = true
  else passThroughArgs.push(arg)
}

// Load/merge config
const saved = loadConfig()
if (relayKey) {
  saveConfig({ ...saved, relayKey, relayUrl: relayUrl || saved.relayUrl || '' })
} else {
  relayKey = saved.relayKey || ''
}
if (!relayUrl) relayUrl = saved.relayUrl || ''

// ── 'start' subcommand — pure background daemon (no Claude Code) ──
if (args[0] === 'start') {
  if (process.env.CODEPOCKET_DAEMON) {
    // We ARE the daemon — fall through to run()
  } else {
    const pid = checkRunning()
    if (pid) {
      console.log(`[codepocket] Already running (PID ${pid})`)
      process.exit(0)
    }
    fs.mkdirSync(LOG_DIR, { recursive: true })
    const logFile = getLogFile()
    const out = fs.openSync(logFile, 'a')
    const daemonArgs = process.argv.slice(2).slice(1) // remove 'start'
    const child = spawn(process.argv[0], [process.argv[1], 'start', ...daemonArgs], {
      stdio: ['ignore', out, out],
      detached: true,
      env: { ...process.env, CODEPOCKET_DAEMON: '1' },
    })
    child.unref()
    fs.writeFileSync(PID_FILE, String(child.pid))
    console.log(`[codepocket] ✓ 已后台启动 (PID ${child.pid})`)
    console.log(`  日志: ${logFile}`)
    console.log(`  codepocket stop   停止`)
    console.log(`  codepocket logs   查看日志`)
    process.exit(0)
  }
}

// ── State ──

let jwt = ''
let relayWs = null
let relayPingInterval = null
let hubBin = findHubBin()

// ── Logging: write to log file when running with Claude Code foreground ──

let _logStream = null
function log(msg) {
  const ts = new Date().toISOString().slice(11, 19)
  const line = `${ts} ${msg}\n`
  if (process.env.CODEPOCKET_DAEMON || CONNECT_ONLY) {
    // daemon/connect-only: write to stdout (redirected to log file by start)
    process.stdout.write(line)
  } else {
    // foreground (Claude Code running): write to log file only
    if (!_logStream) {
      fs.mkdirSync(LOG_DIR, { recursive: true })
      _logStream = fs.openSync(getLogFile(), 'a')
    }
    fs.writeSync(_logStream, line)
  }
}

// ── Hub ──

function waitForHub() {
  return new Promise((resolve) => {
    if (noHub) { resolve(); return }
    isHubRunning(hubUrl).then(up => { if (up) { resolve(); return } })
    let attempts = 0
    const check = setInterval(() => {
      attempts++
      isHubRunning(hubUrl).then(up => {
        if (up) { clearInterval(check); resolve() }
        else if (attempts > 30) { clearInterval(check); resolve() }
      })
    }, 1000)
  })
}

async function startHub(hubBin) {
  if (noHub) return
  if (await isHubRunning(hubUrl)) return
  if (!hubBin) return

  return new Promise((resolve) => {
    const hub = spawn(hubBin, ['hub', 'start'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: { ...process.env, ...HOME_ENV },
    })

    let started = false
    hub.stdout.on('data', () => {}) // swallow
    hub.stderr.on('data', (data) => {
      const text = data.toString()
      if (!started && (text.includes('listening') || text.includes('ready') || text.includes('started'))) {
        started = true
        resolve()
      }
    })

    setTimeout(async () => {
      if (!started && await isHubRunning(hubUrl)) { started = true }
      resolve()
    }, 8000)

    hub.on('exit', () => resolve())
  })
}

// ── Auth ──

async function findHubToken() {
  const hubHome = process.env.CODEPOCKET_HOME || HOME_ENV.CODEPOCKET_HOME
  const settingsPath = path.join(hubHome, 'settings.json')
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    if (settings.cliApiToken) return settings.cliApiToken
  } catch {}
  if (process.env.CLI_API_TOKEN) return process.env.CLI_API_TOKEN
  throw new Error('找不到 Hub token')
}

async function authenticateHub(token) {
  const res = await fetch(`${hubUrl}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: token }),
  })
  if (!res.ok) throw new Error(`Hub auth failed: ${res.status}`)
  return (await res.json()).token
}

// ── SSE ──

async function startSSE() {
  const url = `${hubUrl}/api/events?all=true`
  try {
    const res = await fetch(url, { headers: { Accept: 'text/event-stream', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) } })
    if (!res.ok || !res.body) { setTimeout(startSSE, 5000); return }
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
            try { sendToRelay({ type: 'sse-event', event: JSON.parse(line.slice(5).trim()) }) } catch {}
          }
        }
      }
      setTimeout(startSSE, 5000)
    }
    pump().catch(() => { setTimeout(startSSE, 5000) })
  } catch { setTimeout(startSSE, 5000) }
}

// ── Relay ──

function connectRelay() {
  let savedSession = null

  // Warn about insecure ws:// connections to non-localhost
  if (relayUrl && relayUrl.startsWith('ws://') && !relayUrl.includes('127.0.0.1') && !relayUrl.includes('localhost')) {
    log(`[codepocket] ⚠ 警告: 使用非加密 ws:// 连接到远程服务器，建议使用 wss://`)
  }
  try { savedSession = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) } catch {}

  if (relayPingInterval) { clearInterval(relayPingInterval); relayPingInterval = null }
  if (relayWs) { try { relayWs.removeAllListeners() } catch {} try { relayWs.close() } catch {} relayWs = null }

  relayWs = new WebSocket(relayUrl)

  relayWs.on('open', () => {
    relayWs.send(JSON.stringify({
      type: 'register',
      key: relayKey,
      sessionToken: savedSession?.sessionToken || undefined,
    }))
    relayPingInterval = setInterval(() => {
      if (relayWs?.readyState === WebSocket.OPEN) {
        relayWs.send(JSON.stringify({ type: 'ping' }))
      }
    }, 25000)
  })

  relayWs.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    switch (msg.type) {
      case 'registered': {
        try {
          fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true })
          fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionToken: msg.sessionToken, hubUrl, relayUrl }))
        } catch {}
        if (msg.reconnected) {
          log('[codepocket] ✓ 已重新连接')
        } else {
          log('[codepocket] ✓ 已连接中继')
        }
        break
      }
      case 'client-connected': {
        log('[codepocket] ✓ 小程序已连接')
        break
      }
      case 'rest-request': {
        log(`[DEBUG:relay] rest-request: ${msg.method} ${msg.path}`)
        forwardToHub(msg.requestId, msg.method, msg.path, msg.body)
        break
      }
      case 'auth-request': {
        log(`[DEBUG:relay] auth-request`)
        handleAuthRequest(msg.requestId, msg.accessToken)
        break
      }
      case 'register-error': {
        log(`[codepocket] ✗ ${msg.error}`)
        break
      }
      case 'phone-action-response': {
        onPhoneActionResponse(msg)
        break
      }
      case 'spawn-session': {
        log(`[DEBUG:relay] >>> spawn-session received, directory=${msg.directory}`)
        handleSpawnSession(msg.requestId, msg.directory)
        break
      }
      case 'resume-session': {
        log(`[DEBUG:relay] >>> resume-session received, sessionId=${msg.sessionId}`)
        handleResumeSession(msg.requestId, msg.sessionId)
        break
      }
      case 'list-dir': {
        handleListDir(msg.requestId, msg.path)
        break
      }
    }
  })

  relayWs.on('close', () => {
    if (relayPingInterval) { clearInterval(relayPingInterval); relayPingInterval = null }
    relayWs = null
    setTimeout(connectRelay, 3000)
  })
  relayWs.on('error', () => { relayWs?.close() })
}

function sendToRelay(msg) {
  if (relayWs?.readyState === WebSocket.OPEN) relayWs.send(JSON.stringify(msg))
}

function sendSpawnResult(requestId, sessionId, error) {
  const msg = error
    ? { type: 'spawn-session-result', requestId, success: false, error }
    : { type: 'spawn-session-result', requestId, success: true, sessionId }
  // Retry sending if relay connection is temporarily down
  if (relayWs?.readyState === WebSocket.OPEN) {
    relayWs.send(JSON.stringify(msg))
  } else {
    log(`[codepocket] Relay not open, retrying spawn result in 2s...`)
    setTimeout(() => {
      if (relayWs?.readyState === WebSocket.OPEN) {
        relayWs.send(JSON.stringify(msg))
      } else {
        log(`[codepocket] Failed to send spawn result, relay still down`)
      }
    }, 2000)
  }
}

async function doForwardToHub(requestId, method, p, body) {
  const init = {
    method,
    headers: { 'Content-Type': 'application/json', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
  }
  if (body && method !== 'GET') init.body = JSON.stringify(body)
  return fetch(`${hubUrl}${p}`, init)
}

async function forwardToHub(requestId, method, p, body) {
  // Only allow proxying to /api/ paths
  if (!p || !p.startsWith('/api/')) {
    sendToRelay({ type: 'rest-response', requestId, status: 403, data: { error: 'Forbidden path' } })
    return
  }
  try {
    let res = await doForwardToHub(requestId, method, p, body)
    if (res.status === 401) {
      try {
        const token = await findHubToken()
        jwt = await authenticateHub(token)
        res = await doForwardToHub(requestId, method, p, body)
      } catch {}
    }
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
    sendToRelay({ type: 'auth-response', requestId, ok: res.ok, data: await res.json() })
  } catch (err) {
    sendToRelay({ type: 'auth-response', requestId, ok: false, data: { error: err.message } })
  }
}

async function handleSpawnSession(requestId, directory) {
  log(`[DEBUG:spawn] === START spawn-session ===`)
  log(`[DEBUG:spawn] requestId=${requestId}, raw directory=${directory}`)
  log(`[DEBUG:spawn] hubBin=${hubBin}, hubUrl=${hubUrl}, jwt=${jwt ? 'set' : 'EMPTY'}`)

  if (!hubBin) {
    log(`[DEBUG:spawn] FAIL: hubBin is null`)
    sendToRelay({ type: 'spawn-session-result', requestId, success: false, error: 'Hub binary not found' })
    return
  }
  if (!directory || typeof directory !== 'string') {
    log(`[DEBUG:spawn] FAIL: directory invalid`)
    sendToRelay({ type: 'spawn-session-result', requestId, success: false, error: 'Directory is required' })
    return
  }

  // Expand ~ to home directory
  directory = directory.replace(/^~/, os.homedir())
  const absDir = path.resolve(directory)

  // Only allow spawning in home directory
  const home = os.homedir()
  if (!absDir.startsWith(home)) {
    log(`[DEBUG:spawn] FAIL: directory outside home: ${absDir}`)
    sendToRelay({ type: 'spawn-session-result', requestId, success: false, error: 'Access denied: directory outside home' })
    return
  }
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    log(`[DEBUG:spawn] FAIL: directory does not exist: ${absDir}`)
    sendToRelay({ type: 'spawn-session-result', requestId, success: false, error: 'Directory does not exist' })
    return
  }

  log(`[DEBUG:spawn] Expanded directory: ${absDir}`)

  try {
    const spawnArgs = ['claude', '--codepocket-starting-mode', 'remote']
    log(`[DEBUG:spawn] Spawning: ${hubBin} ${spawnArgs.join(' ')} in ${absDir}`)

    const child = spawn(hubBin, spawnArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      cwd: absDir,
      env: { ...process.env, ...HOME_ENV },
    })
    log(`[DEBUG:spawn] Process spawned, PID=${child.pid}`)
    let spawnStderr = ''
    child.stderr.on('data', (d) => {
      const text = d.toString().trim()
      if (text) {
        spawnStderr += text + '\n'
        log(`[DEBUG:spawn] stderr: ${text.slice(0, 500)}`)
      }
    })
    child.stdout.on('data', (d) => {
      const text = d.toString().trim()
      if (text) log(`[DEBUG:spawn] stdout: ${text.slice(0, 500)}`)
    })
    child.unref()
    child.on('error', (err) => {
      log(`[DEBUG:spawn] Process error: ${err.message}`)
    })
    child.on('exit', (code, signal) => {
      log(`[DEBUG:spawn] Process exited: code=${code}, signal=${signal}, PID=${child.pid}`)
      if (spawnStderr) log(`[DEBUG:spawn] Full stderr:\n${spawnStderr.slice(0, 2000)}`)
    })

    // Refresh JWT before polling
    log(`[DEBUG:spawn] Refreshing JWT...`)
    try {
      const token = await findHubToken()
      jwt = await authenticateHub(token)
      log(`[DEBUG:spawn] JWT refreshed OK`)
    } catch (err) {
      log(`[DEBUG:spawn] JWT refresh failed: ${err.message}`)
    }

    // Wait for session to be created by polling /sessions
    const spawnTime = Date.now()
    let sessionId = null
    let sessionActive = false
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000))
      try {
        let res = await fetch(`${hubUrl}/api/sessions`, {
          headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
        })
        // Refresh JWT on 401
        if (res.status === 401) {
          log(`[DEBUG:spawn] Poll #${i + 1}: got 401, refreshing JWT...`)
          try {
            const token = await findHubToken()
            jwt = await authenticateHub(token)
            res = await fetch(`${hubUrl}/api/sessions`, {
              headers: { Authorization: `Bearer ${jwt}` },
            })
          } catch (err) {
            log(`[DEBUG:spawn] JWT refresh on 401 failed: ${err.message}`)
          }
        }
        const data = await res.json()
        const sessions = data.sessions || (Array.isArray(data) ? data : [])
        log(`[DEBUG:spawn] Poll #${i + 1}: ${sessions.length} sessions, status=${res.status}`)

        // Match by path AND updated after spawn (avoid stale sessions)
        const match = sessions.find(s =>
          s.metadata?.path === absDir && s.id
          && (!s.updatedAt || s.updatedAt * 1000 >= spawnTime - 5000)
        )
        if (match) {
          sessionId = match.id
          sessionActive = !!match.active
          log(`[DEBUG:spawn] Poll #${i + 1}: FOUND session=${sessionId}, active=${sessionActive}`)
          if (sessionActive) break  // found and active, done
          // Session exists but not yet active — keep polling
        }
      } catch (err) {
        log(`[DEBUG:spawn] Poll #${i + 1}: fetch error: ${err.message}`)
      }
    }

    if (sessionId) {
      log(`[DEBUG:spawn] RESULT: sessionId=${sessionId}, active=${sessionActive}`)
    } else {
      log(`[DEBUG:spawn] RESULT: session NOT FOUND after 30 polls, directory=${absDir}`)
    }
    sendSpawnResult(requestId, sessionId)
  } catch (err) {
    log(`[DEBUG:spawn] EXCEPTION: ${err.message}`)
    sendSpawnResult(requestId, null, err.message)
  }
}

async function handleResumeSession(requestId, sessionId) {
  log(`[DEBUG:resume] === START resume-session ===`)
  log(`[DEBUG:resume] requestId=${requestId}, sessionId=${sessionId}`)

  if (!hubBin) {
    sendToRelay({ type: 'resume-session-result', requestId, success: false, error: 'Hub binary not found' })
    return
  }
  if (!sessionId) {
    sendToRelay({ type: 'resume-session-result', requestId, success: false, error: 'Session ID is required' })
    return
  }

  try {
    // 1. Fetch session metadata to get the working directory
    let res = await fetch(`${hubUrl}/api/sessions/${sessionId}`, {
      headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
    })
    if (res.status === 401) {
      const token = await findHubToken()
      jwt = await authenticateHub(token)
      res = await fetch(`${hubUrl}/api/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      })
    }
    if (!res.ok) {
      sendToRelay({ type: 'resume-session-result', requestId, success: false, error: `Session not found (${res.status})` })
      return
    }
    const data = await res.json()
    const session = data.session || data
    const directory = (session.metadata?.path || '').replace(/^~/, os.homedir())
    if (!directory) {
      sendToRelay({ type: 'resume-session-result', requestId, success: false, error: 'Session has no working directory' })
      return
    }

    // 2. Spawn in remote mode with --resume to load old conversation context
    let claudeSessionId = session.metadata?.agentSessionId || session.metadata?.claudeSessionId
    if (!claudeSessionId) {
      claudeSessionId = findClaudeSessionFile(directory)
      log(`[DEBUG:resume] claudeSessionId from file scan: ${claudeSessionId || 'NOT FOUND'}`)
    }
    const spawnArgs = ['claude', '--codepocket-starting-mode', 'remote']
    if (claudeSessionId) {
      spawnArgs.push('--resume', claudeSessionId)
    }
    log(`[DEBUG:resume] claudeSessionId: ${claudeSessionId || 'NONE'}`)

    // Log sessions BEFORE spawn
    try {
      const beforeRes = await fetch(`${hubUrl}/api/sessions`, {
        headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
      })
      const beforeData = await beforeRes.json()
      const beforeSessions = beforeData.sessions || []
      const dirSessions = beforeSessions.filter(s => s.metadata?.path === directory)
      log(`[DEBUG:resume] BEFORE spawn: ${dirSessions.length} sessions for ${directory}: ${dirSessions.map(s => `${s.id}(active=${s.active})`).join(', ')}`)
    } catch {}

    log(`[DEBUG:resume] Spawning: ${hubBin} ${spawnArgs.join(' ')} (cwd=${directory})`)
    log(`[DEBUG:resume] ENV CODEPOCKET_HOME=${process.env.CODEPOCKET_HOME || HOME_ENV.CODEPOCKET_HOME}`)
    const child = spawn(hubBin, spawnArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      cwd: directory,
      env: { ...process.env, ...HOME_ENV },
    })
    log(`[DEBUG:resume] Process spawned, PID=${child.pid}`)

    // Check if process is still alive after 500ms
    setTimeout(() => {
      try {
        process.kill(child.pid, 0)
        log(`[DEBUG:resume] Health check: PID=${child.pid} is alive`)
      } catch (e) {
        log(`[DEBUG:resume] Health check: PID=${child.pid} is DEAD already: ${e.message}`)
      }
    }, 500)

    let resumeStderr = ''
    child.stderr.on('data', (d) => {
      const text = d.toString().trim()
      if (text) {
        resumeStderr += text + '\n'
        log(`[DEBUG:resume] stderr: ${text.slice(0, 500)}`)
      }
    })
    child.stdout.on('data', (d) => {
      const text = d.toString().trim()
      if (text) log(`[DEBUG:resume] stdout: ${text.slice(0, 500)}`)
    })
    child.unref()
    child.on('error', (err) => {
      log(`[DEBUG:resume] Process error: ${err.message}`)
    })
    child.on('exit', (code, signal) => {
      log(`[DEBUG:resume] Process exited: code=${code}, signal=${signal}, PID=${child.pid}`)
      if (resumeStderr) log(`[DEBUG:resume] Full stderr:\n${resumeStderr.slice(0, 2000)}`)
    })

    // 3. Refresh JWT and poll for new session
    try {
      const token = await findHubToken()
      jwt = await authenticateHub(token)
    } catch (err) {
      log(`[DEBUG:resume] JWT refresh failed: ${err.message}`)
    }

    const spawnTime = Date.now()
    let newSessionId = null
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000))
      try {
        let pollRes = await fetch(`${hubUrl}/api/sessions`, {
          headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
        })
        if (pollRes.status === 401) {
          const token = await findHubToken()
          jwt = await authenticateHub(token)
          pollRes = await fetch(`${hubUrl}/api/sessions`, {
            headers: { Authorization: `Bearer ${jwt}` },
          })
        }
        const pollData = await pollRes.json()
        const sessions = pollData.sessions || (Array.isArray(pollData) ? pollData : [])
        // Find a NEW session (created after spawn) for the same directory
        const match = sessions.find(s =>
          s.metadata?.path === directory && s.id
          && (!s.updatedAt || s.updatedAt * 1000 >= spawnTime - 5000)
          && s.id !== sessionId
        )
        if (match) {
          newSessionId = match.id
          log(`[DEBUG:resume] Poll #${i + 1}: FOUND new session=${match.id}, active=${!!match.active}`)
          if (match.active) break
        }
      } catch (err) {
        log(`[DEBUG:resume] Poll #${i + 1}: error: ${err.message}`)
      }
    }

    if (newSessionId) {
      // Don't delete old session — mini-program needs it for message history
      log(`[DEBUG:resume] RESULT: new session=${newSessionId}, old session=${sessionId} preserved for history`)
      sendToRelay({ type: 'resume-session-result', requestId, success: true, sessionId: newSessionId, oldSessionId: sessionId })
    } else {
      log(`[DEBUG:resume] RESULT: no new session found after 30 polls`)
      sendToRelay({ type: 'resume-session-result', requestId, success: true, sessionId: null, warning: 'Session resuming' })
    }
  } catch (err) {
    log(`[DEBUG:resume] EXCEPTION: ${err.message}`)
    sendToRelay({ type: 'resume-session-result', requestId, success: false, error: err.message })
  }
}

function handleListDir(requestId, dirPath) {
  try {
    const home = os.homedir()
    const resolved = (dirPath || '~').replace(/^~/, home)
    const abs = path.resolve(resolved)
    // Only allow listing under home directory
    if (!abs.startsWith(home)) {
      sendToRelay({ type: 'list-dir-result', requestId, error: 'Access denied: directory outside home' })
      return
    }
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => ({ name: d.name, path: path.join(abs, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    sendToRelay({ type: 'list-dir-result', requestId, path: abs, entries })
  } catch (err) {
    sendToRelay({ type: 'list-dir-result', requestId, error: err.message })
  }
}

// ── Background connect: auth + MCP + SSE + relay ──

async function connectInBackground() {
  log(`[DEBUG:bg] connectInBackground called, relayUrl=${relayUrl || 'EMPTY'}`)
  if (!relayUrl) {
    log(`[DEBUG:bg] No relay URL configured, skipping background connect`)
    console.log('[codepocket] 未配置 Relay 地址，手机连接功能不可用')
    return
  }
  try {
    const token = await findHubToken()
    jwt = await authenticateHub(token)
    log(`[DEBUG:bg] JWT acquired OK`)
  } catch (err) {
    log(`[DEBUG:bg] JWT acquire failed: ${err.message}`)
  }

  try {
    const mcpPort = await startMcpServer(sendToRelay)
    injectMcpConfig(mcpPort)
    log(`[DEBUG:bg] MCP server started on port ${mcpPort}`)
  } catch (err) {
    log(`[DEBUG:bg] MCP server failed: ${err.message}`)
  }

  startSSE()
  connectRelay()
  log(`[DEBUG:bg] Background connect complete`)
}

// ── Main ──

async function run() {

  // 1. Key setup (interactive if first time)
  if (!relayKey) {
    if (process.env.CODEPOCKET_DAEMON) {
      console.error('[codepocket] ✗ 无 Key，请在前台运行 codepocket 配置')
      process.exit(1)
    }
    console.log('[codepocket] 首次使用，请输入 Key')
    console.log('  在 CodePocket 小程序中获取 Key →')
    relayKey = await new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      rl.question('  Key: ', (answer) => {
        rl.close()
        resolve(answer.trim())
      })
    })
    if (!relayKey) {
      console.error('[codepocket] ✗ Key 不能为空')
      process.exit(1)
    }
  }

  // 1.5 Relay URL (set RELAY_WS_URL env or --relay flag)
  if (!relayUrl) {
    relayUrl = DEFAULT_RELAY_URL
  }

  if (relayKey) {
    saveConfig({ ...loadConfig(), relayKey, relayUrl })
    console.log('[codepocket] ✓ 配置已保存')
  }

  // 2. Daemon mode: full hub + relay setup
  if (process.env.CODEPOCKET_DAEMON) {
    if (!noHub) await startHub(hubBin)
    connectInBackground()
    console.log('[codepocket] ✓ 后台服务已就绪，等待小程序...')
    return
  }

  // 3. Connect-only mode (same as old daemon for manual use)
  if (CONNECT_ONLY) {
    if (!noHub) await startHub(hubBin)
    connectInBackground()
    console.log('[codepocket] ✓ 已连接，等待小程序...')
    return
  }

  // 4. Foreground: ensure daemon running, then just spawn Claude
  if (!noHub) {
    const daemonPid = checkRunning()
    if (!daemonPid) {
      // Auto-start daemon
      fs.mkdirSync(LOG_DIR, { recursive: true })
      const logFile = getLogFile()
      const out = fs.openSync(logFile, 'a')
      const daemonChild = spawn(process.argv[0], [process.argv[1], 'start'], {
        stdio: ['ignore', out, out],
        detached: true,
        env: { ...process.env, CODEPOCKET_DAEMON: '1' },
      })
      daemonChild.unref()
      fs.writeFileSync(PID_FILE, String(daemonChild.pid))
      console.log(`[codepocket] ✓ 后台服务已启动 (PID ${daemonChild.pid})`)
    } else {
      console.log(`[codepocket] ✓ 后台服务运行中 (PID ${daemonPid})`)
    }
    // Wait for hub to be ready (started by daemon)
    await waitForHub()
  }

  // 5. Launch Claude Code (foreground)
  if (!hubBin) {
    console.error('[codepocket] ✗ 找不到 Hub 二进制')
    process.exit(1)
  }

  const child = spawn(hubBin, passThroughArgs, {
    stdio: 'inherit',
    env: { ...process.env, ...HOME_ENV },
  })
  child.on('exit', (code) => process.exit(code || 0))
}

run().catch((err) => {
  console.error('[codepocket] ✗ 启动失败:', err.message)
  process.exit(1)
})
