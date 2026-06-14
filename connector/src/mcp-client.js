/**
 * Simple MCP client — connects to the running codepocket MCP server via SSE,
 * sends tool calls, and returns results.
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const readline = require('readline')
const os = require('os')

const MCP_PORTS = Array.from({ length: 10 }, (_, i) => 3007 + i)
const TRACK_FILE = path.join(os.tmpdir(), 'codepocket-last-track.json')

// ── MCP Client ──

class McpClient {
  constructor(port) {
    this.port = port
    this.baseUrl = `http://127.0.0.1:${port}`
    this.sseBuffer = ''
    this.pending = new Map() // id -> { resolve, reject }
    this.nextId = 1
    this.connected = false
  }

  /** Discover and connect to a running MCP server */
  static async connect() {
    for (const port of MCP_PORTS) {
      try {
        const res = await new Promise((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${port}/sse`, (res) => {
            resolve(res)
          })
          req.on('error', reject)
          req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')) })
        })

        if (res.statusCode === 200) {
          const client = new McpClient(port)
          await client._startSSE(res)
          return client
        }
        res.resume()
      } catch {}
    }
    throw new Error('未找到运行中的 MCP server (tried ports 3007-3016)')
  }

  _startSSE(res) {
    return new Promise((resolve, reject) => {
      let buffer = ''
      res.setEncoding('utf-8')
      res.on('data', (chunk) => {
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data.startsWith('http')) {
              // endpoint event — connected
              this.connected = true
              resolve()
              continue
            }
            try {
              const msg = JSON.parse(data)
              if (msg.id && this.pending.has(msg.id)) {
                const { resolve: done } = this.pending.get(msg.id)
                this.pending.delete(msg.id)
                done(msg)
              }
            } catch {}
          }
        }
      })
      res.on('error', reject)
      res.on('end', () => {
        this.connected = false
        // Reject all pending
        for (const [id, { reject }] of this.pending) {
          this.pending.delete(id)
          reject(new Error('SSE connection closed'))
        }
      })
      // Timeout for initial connection
      setTimeout(() => {
        if (!this.connected) reject(new Error('SSE connection timeout'))
      }, 3000)
    })
  }

  /** Call an MCP tool and return the parsed result */
  async call(toolName, args = {}) {
    const id = this.nextId++
    const msg = {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Tool call "${toolName}" timed out (60s)`))
      }, 60000)

      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer)
          resolve(msg)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })

      const body = JSON.stringify(msg)
      const req = http.request(`${this.baseUrl}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        res.resume()
        if (res.statusCode !== 202) {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(new Error(`Unexpected status: ${res.statusCode}`))
        }
      })
      req.on('error', (err) => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err)
      })
      req.write(body)
      req.end()
    })
  }

  /** Extract tool result from MCP response */
  static extractResult(mcpMsg) {
    try {
      const text = mcpMsg.result?.content?.[0]?.text
      if (text) return JSON.parse(text)
    } catch {}
    return null
  }
}

// ── Test Commands ──

async function cmdLocation() {
  const client = await McpClient.connect()
  console.log('获取位置中...')
  const resp = await client.call('phone_location_get')
  const result = McpClient.extractResult(resp)
  if (result?.accepted && result.result) {
    const loc = result.result
    console.log(`  纬度: ${loc.latitude}`)
    console.log(`  经度: ${loc.longitude}`)
    console.log(`  精度: ${loc.accuracy}m`)
  } else {
    console.error('  获取失败:', result?.error || '未知错误')
  }
}

async function cmdTrack() {
  const client = await McpClient.connect()
  console.log('开始追踪，手机上确认...')
  const resp = await client.call('phone_location_track')
  const result = McpClient.extractResult(resp)
  if (result?.accepted && result.result?.success) {
    console.log('  追踪已开始，走动一会儿后运行:')
    console.log('    codepocket test stop')
  } else {
    console.error('  启动失败:', result?.error || '未知错误')
  }
}

async function cmdStop() {
  const client = await McpClient.connect()
  console.log('停止追踪...')
  const resp = await client.call('phone_location_stop')
  const result = McpClient.extractResult(resp)
  if (result?.accepted && result.result?.success) {
    const { points, count, debug } = result.result
    const duration = count >= 2
      ? ((points[points.length - 1].timestamp - points[0].timestamp) / 1000).toFixed(1) + 's'
      : 'N/A'

    console.log(`  采集点数: ${count}`)
    console.log(`  时长: ${duration}`)

    if (debug?.length) {
      console.log('  调试日志:')
      debug.forEach((d) => console.log(`    ${d}`))
    }

    // Save track data for map command
    if (count >= 2) {
      fs.writeFileSync(TRACK_FILE, JSON.stringify({ points, count, savedAt: Date.now() }))
      console.log(`\n  轨迹已保存，运行下面命令查看地图:`)
      console.log('    codepocket test map')
    }
  } else {
    console.error('  停止失败:', result?.error || '未知错误')
  }
}

async function cmdMap() {
  // Load saved track data
  if (!fs.existsSync(TRACK_FILE)) {
    console.error('  未找到轨迹数据，请先运行 codepocket test track → stop')
    process.exit(1)
  }

  const track = JSON.parse(fs.readFileSync(TRACK_FILE, 'utf-8'))
  const { points } = track

  console.log(`  加载 ${points.length} 个轨迹点...`)

  const polylinePoints = points.map((p) => ({
    latitude: p.latitude,
    longitude: p.longitude,
    timestamp: p.timestamp,
  }))

  const markers = [
    { latitude: points[0].latitude, longitude: points[0].longitude, title: '起点' },
    { latitude: points[points.length - 1].latitude, longitude: points[points.length - 1].longitude, title: '终点' },
  ]

  const client = await McpClient.connect()
  console.log('  发送地图到手机...')
  const resp = await client.call('phone_map_show', {
    polyline: [{ points: polylinePoints, color: '#00C853', width: 4 }],
    markers,
    title: '轨迹地图',
  })

  const result = McpClient.extractResult(resp)
  if (result?.accepted) {
    console.log('  地图已显示到手机!')
  } else {
    console.error('  显示失败:', result?.error || '未知错误')
  }
}

async function cmdFlow() {
  const client = await McpClient.connect()

  // Step 1: Track
  console.log('\n[1/3] 开始追踪，手机上确认...')
  const trackResp = await client.call('phone_location_track')
  const trackResult = McpClient.extractResult(trackResp)
  if (!trackResult?.accepted || !trackResult.result?.success) {
    console.error('  追踪启动失败:', trackResult?.error || '未知错误')
    process.exit(1)
  }
  console.log('  追踪中...')

  // Step 2: Wait for user
  console.log('\n  走动一会儿，按回车停止追踪...')
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.on('line', () => { rl.close(); resolve() })
  })

  // Step 3: Stop
  console.log('\n[2/3] 停止追踪...')
  const stopResp = await client.call('phone_location_stop')
  const stopResult = McpClient.extractResult(stopResp)
  if (!stopResult?.accepted || !stopResult.result?.success) {
    console.error('  停止失败:', stopResult?.error || '未知错误')
    process.exit(1)
  }

  const { points, count } = stopResult.result
  const duration = count >= 2
    ? ((points[points.length - 1].timestamp - points[0].timestamp) / 1000).toFixed(1) + 's'
    : 'N/A'
  console.log(`  ${count} 个点, ${duration}`)

  if (count < 2) {
    console.error('  点数不足，无法画地图')
    process.exit(1)
  }

  // Save track
  fs.writeFileSync(TRACK_FILE, JSON.stringify({ points, count, savedAt: Date.now() }))

  // Step 4: Map
  console.log('\n[3/3] 画地图...')
  const polylinePoints = points.map((p) => ({
    latitude: p.latitude,
    longitude: p.longitude,
    timestamp: p.timestamp,
  }))
  const markers = [
    { latitude: points[0].latitude, longitude: points[0].longitude, title: '起点' },
    { latitude: points[points.length - 1].latitude, longitude: points[points.length - 1].longitude, title: '终点' },
  ]

  const mapResp = await client.call('phone_map_show', {
    polyline: [{ points: polylinePoints, color: '#00C853', width: 4 }],
    markers,
    title: '轨迹地图',
  })

  const mapResult = McpClient.extractResult(mapResp)
  if (mapResult?.accepted) {
    console.log('  地图已显示到手机!')
  } else {
    console.error('  显示失败:', mapResult?.error || '未知错误')
  }
}

// ── CLI Entry ──

const COMMANDS = { location: cmdLocation, track: cmdTrack, stop: cmdStop, map: cmdMap, flow: cmdFlow }

async function runTestCli(args) {
  const cmd = args[0]
  if (!cmd || !COMMANDS[cmd]) {
    console.log('用法: codepocket test <command>')
    console.log('')
    console.log('命令:')
    console.log('  location   获取当前位置')
    console.log('  track      开始位置追踪')
    console.log('  stop       停止追踪并保存轨迹')
    console.log('  map        用最近轨迹画地图')
    console.log('  flow       全流程: 追踪 → 停止 → 画地图')
    process.exit(cmd ? 1 : 0)
  }

  try {
    await COMMANDS[cmd]()
  } catch (err) {
    console.error(`\n  [!] ${err.message}`)
    process.exit(1)
  }
}

module.exports = { runTestCli }
