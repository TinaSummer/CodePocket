# CodeMind Relay — 宝塔面板部署指南

## 前提

- 腾讯云轻量服务器，已安装宝塔面板
- 一个已备案域名（小程序要求 HTTPS + 域名备案）
- 域名已解析到服务器 IP

---

## 一、宝塔面板准备

### 1. 安装必要软件

在宝塔「软件商店」中安装：

- **Nginx**（通常已装）
- **PM2管理器**（用于守护 relay 进程）
- **Node.js版本管理器**（安装 Node 20+，用于 npx）

> 不需要安装 Bun，relay 也可以用 Node 运行（见下方）

### 2. 放行端口

宝塔「安全」→「防火墙」→ 放行：

| 端口 | 用途 |
|------|------|
| 80 | HTTP（SSL 验证用） |
| 443 | HTTPS |

> 3010 端口 **不要放行**，relay 只绑定 127.0.0.1

### 3. 腾讯云防火墙

登录腾讯云控制台 → 轻量应用服务器 → 防火墙，同样放行 80、443。

---

## 二、部署 Relay 服务

### 方案 A：用 Node 运行（推荐，宝塔友好）

relay 依赖只有 `hono`，兼容 Node.js。添加一个 Node 入口文件：

#### 1. 上传代码

SSH 登录服务器后执行：

```bash
# 创建目录
sudo mkdir -p /opt/codemind-relay/src
cd /opt/codemind-relay

# 创建 package.json
cat > package.json << 'EOF'
{
  "name": "codemind-relay",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "node src/index.js"
  },
  "dependencies": {
    "hono": "^4.7.0",
    "@hono/node-ws": "^1.3.0",
    "@hono/node-server": "^1.13.0"
  }
}
EOF

# 安装依赖
npm install --production
```

#### 2. 创建 Relay 源码

```bash
cat > src/index.js << 'ENDOFFILE'
/**
 * CodeMind Relay — 宝塔 Node.js 版
 */
const { Hono } = require('hono')
const { serve } = require('@hono/node-server')
const { createNodeWebSocket } = require('@hono/node-ws')
const crypto = require('crypto')

const app = new Hono()
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket(app)

const RELAY_PORT = parseInt(process.env.RELAY_PORT || '3010')
const RELAY_KEY = process.env.RELAY_KEY || ''
const PAIR_CODE_TTL = 10 * 60 * 1000

if (!RELAY_KEY) {
  console.error('[!] 必须设置 RELAY_KEY 环境变量')
  process.exit(1)
}

const hubs = new Map()
const clients = new Map()
const pendingPairs = new Map()
const pendingRestRequests = new Map()
const pendingAuthRequests = new Map()
const failedAttempts = new Map()
const MAX_FAILED_ATTEMPTS = 10
const FAILED_WINDOW = 5 * 60 * 1000

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

function genToken() {
  return Array.from(crypto.randomBytes(32), b => b.toString(16).padStart(2, '0')).join('')
}

function checkRateLimit(ip) {
  const r = failedAttempts.get(ip)
  if (!r) return true
  if (Date.now() - r.lastAttempt > FAILED_WINDOW) { failedAttempts.delete(ip); return true }
  return r.count < MAX_FAILED_ATTEMPTS
}

function recordFailedAttempt(ip) {
  const r = failedAttempts.get(ip) || { count: 0, lastAttempt: 0 }
  r.count++; r.lastAttempt = Date.now()
  failedAttempts.set(ip, r)
}

function findHubByClient(ws) {
  const client = clients.get(ws._clientToken)
  if (!client?.hubToken) return null
  return hubs.get(client.hubToken) || null
}

function cleanupHub(token) {
  const hub = hubs.get(token)
  if (!hub) return
  for (const cws of hub.clients) {
    const client = clients.get(cws._clientToken)
    if (client) client.hubToken = null
    try { cws.send(JSON.stringify({ type: 'hub-disconnected' })) } catch {}
  }
  hubs.delete(token)
}

// Periodic cleanup
setInterval(() => {
  const now = Date.now()
  for (const [code, id] of pendingPairs) {
    const h = hubs.get(id)
    if (!h || now > h.codeExpires) { pendingPairs.delete(code); if (h) h.code = '' }
  }
  for (const [id, r] of pendingRestRequests) { if (now > r.expires) pendingRestRequests.delete(id) }
  for (const [id, r] of pendingAuthRequests) { if (now > r.expires) pendingAuthRequests.delete(id) }
  for (const [ip, r] of failedAttempts) { if (now - r.lastAttempt > FAILED_WINDOW) failedAttempts.delete(ip) }
}, 60_000)

app.get('/', (c) => c.json({
  name: 'codemind-relay',
  version: '1.0.0',
  connections: { hubs: hubs.size, clients: clients.size },
}))

// WebSocket handler
upgradeWebSocket(() => ({
  onOpen(event, ws) {
    ws._raw._clientToken = ''
    ws._raw._hubToken = ''
    ws._raw._role = null
    ws._raw._ip = ''
  },

  onMessage(event, ws) {
    let msg
    try { msg = JSON.parse(event.data) } catch { return }
    const raw = ws._raw

    switch (msg.type) {
      case 'register': {
        if (msg.key !== RELAY_KEY) {
          ws.send(JSON.stringify({ type: 'register-error', error: 'Invalid key' }))
          ws.close(4001, 'Invalid key')
          return
        }
        raw._role = 'hub'
        if (msg.sessionToken && hubs.has(msg.sessionToken)) {
          const existing = hubs.get(msg.sessionToken)
          existing.ws = raw
          raw._hubToken = msg.sessionToken
          ws.send(JSON.stringify({
            type: 'registered', code: existing.code || genCode(),
            sessionToken: msg.sessionToken, reconnected: true,
          }))
          return
        }
        const code = genCode()
        const st = genToken()
        hubs.set(st, { ws: raw, code, codeExpires: Date.now() + PAIR_CODE_TTL, sessionToken: st, clients: new Set(), lastSeen: Date.now() })
        pendingPairs.set(code, st)
        raw._hubToken = st
        ws.send(JSON.stringify({ type: 'registered', code, sessionToken: st, reconnected: false }))
        break
      }

      case 'pair': {
        raw._role = 'client'
        if (!checkRateLimit(raw._ip || 'unknown')) {
          ws.send(JSON.stringify({ type: 'pair-error', error: 'Too many attempts' }))
          return
        }
        const ct = msg.clientToken || genToken()
        if (ct && clients.has(ct)) {
          const existing = clients.get(ct)
          existing.ws = raw
          raw._clientToken = ct
          ws.send(JSON.stringify({ type: 'paired', sessionToken: existing.hubToken, reconnected: true }))
          return
        }
        const code = String(msg.code).trim()
        const hubId = pendingPairs.get(code)
        if (!hubId) {
          recordFailedAttempt(raw._ip || 'unknown')
          ws.send(JSON.stringify({ type: 'pair-error', error: '配对码无效或已过期' }))
          return
        }
        const hub = hubs.get(hubId)
        if (!hub) { ws.send(JSON.stringify({ type: 'pair-error', error: 'Hub 不在线' })); return }
        clients.set(ct, { ws: raw, hubToken: hub.sessionToken, clientToken: ct })
        hub.clients.add(raw)
        raw._clientToken = ct
        pendingPairs.delete(code)
        hub.code = ''
        ws.send(JSON.stringify({ type: 'paired', sessionToken: hub.sessionToken }))
        try { hub.ws.send(JSON.stringify({ type: 'client-connected' })) } catch {}
        break
      }

      case 'sse-event': {
        const hub = hubs.get(raw._hubToken)
        if (!hub) return
        hub.lastSeen = Date.now()
        const payload = JSON.stringify({ type: 'sse-event', event: msg.event })
        for (const cws of hub.clients) try { cws.send(payload) } catch {}
        break
      }

      case 'rest-response': {
        const pending = pendingRestRequests.get(msg.requestId)
        if (pending) { pendingRestRequests.delete(msg.requestId); try { pending.ws.send(JSON.stringify(msg)) } catch {} }
        break
      }

      case 'auth-response': {
        const pending = pendingAuthRequests.get(msg.requestId)
        if (pending) { pendingAuthRequests.delete(msg.requestId); try { pending.ws.send(JSON.stringify(msg)) } catch {} }
        break
      }

      case 'rest-request': {
        const hub = findHubByClient(raw)
        if (!hub) {
          ws.send(JSON.stringify({ type: 'rest-response', requestId: msg.requestId, status: 503, data: { error: 'Hub offline' } }))
          return
        }
        pendingRestRequests.set(msg.requestId, { ws: raw, expires: Date.now() + 30_000 })
        try { hub.ws.send(JSON.stringify({ type: 'rest-request', requestId: msg.requestId, method: msg.method, path: msg.path, body: msg.body })) } catch {
          pendingRestRequests.delete(msg.requestId)
          ws.send(JSON.stringify({ type: 'rest-response', requestId: msg.requestId, status: 503, data: { error: 'Hub offline' } }))
        }
        break
      }

      case 'auth-request': {
        const hub = findHubByClient(raw)
        if (!hub) {
          ws.send(JSON.stringify({ type: 'auth-response', requestId: msg.requestId, ok: false, data: { error: 'Hub offline' } }))
          return
        }
        pendingAuthRequests.set(msg.requestId, { ws: raw, expires: Date.now() + 30_000 })
        try { hub.ws.send(JSON.stringify({ type: 'auth-request', requestId: msg.requestId, accessToken: msg.accessToken })) } catch {
          ws.send(JSON.stringify({ type: 'auth-response', requestId: msg.requestId, ok: false, data: { error: 'Hub offline' } }))
        }
        break
      }
    }
  },

  onClose(event, ws) {
    const raw = ws._raw
    if (raw._role === 'hub' && raw._hubToken) {
      setTimeout(() => {
        const hub = hubs.get(raw._hubToken)
        if (hub?.ws === raw) cleanupHub(raw._hubToken)
      }, 60_000)
    }
    if (raw._role === 'client') {
      const hub = raw._hubToken ? hubs.get(raw._hubToken) : null
      if (hub) hub.clients.delete(raw)
    }
  },
}))

serve({ fetch: app.fetch, port: RELAY_PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`[relay] listening on 127.0.0.1:${info.port}`)
  console.log(`[relay] key: ${RELAY_KEY.slice(0, 8)}...`)
})
ENDOFFILE
```

#### 3. 生成密钥 + 配置环境变量

```bash
# 生成密钥
RELAY_KEY=$(openssl rand -hex 32)

# 保存到环境文件
sudo tee /etc/codemind-relay.env << EOF
RELAY_PORT=3010
RELAY_KEY=$RELAY_KEY
NODE_ENV=production
EOF

sudo chmod 600 /etc/codemind-relay.env

echo "你的 RELAY_KEY: $RELAY_KEY"
echo "⚠️  请立即保存这个密钥！"
```

#### 4. 测试启动

```bash
cd /opt/codemind-relay
export $(cat /etc/codemind-relay.env | xargs)
node src/index.js
# 应该看到: [relay] listening on 127.0.0.1:3010
# Ctrl+C 退出
```

#### 5. 用 PM2 守护

宝塔「软件商店」→「PM2管理器」→「添加项目」：

| 字段 | 值 |
|------|-----|
| 启动文件 | `/opt/codemind-relay/src/index.js` |
| 运行目录 | `/opt/codemind-relay` |
| 项目名称 | `codemind-relay` |
| 环境变量 | 见下方 |

或者用命令行：

```bash
cd /opt/codemind-relay
pm2 start src/index.js --name codemind-relay \
  --env RELAY_PORT=3010 \
  --env RELAY_KEY=$(grep RELAY_KEY /etc/codemind-relay.env | cut -d= -f2)

pm2 save
pm2 startup
```

> PM2 管理器会自动在服务器重启后恢复进程

---

## 三、宝塔 Nginx 反向代理

### 1. 添加站点

宝塔「网站」→「添加站点」：

| 字段 | 值 |
|------|-----|
| 域名 | `你的域名.com` |
| PHP版本 | 纯静态 |
| 根目录 | 随意（不会用到） |

### 2. 申请 SSL 证书

点击站点名 →「SSL」→「Let's Encrypt」→ 勾选域名 →「申请」

申请成功后开启「强制HTTPS」

### 3. 配置反向代理

点击站点名 →「反向代理」→「添加反向代理」：

| 字段 | 值 |
|------|-----|
| 代理名称 | `codemind-ws` |
| 目标URL | `http://127.0.0.1:3010` |
| 发送域名 | `$host` |

### 4. 添加 WebSocket 支持

点击刚创建的反向代理 →「自定义配置」，替换为：

```nginx
# WebSocket 路径
location /ws {
    proxy_pass http://127.0.0.1:3010;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

# REST API
location / {
    proxy_pass http://127.0.0.1:3010;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

> 如果宝塔的反向代理界面不支持自定义配置，改为：站点 →「配置文件」，找到 `server` 块内的 `location` 段，替换为上面的内容。

---

## 四、更新小程序连接地址

修改 `miniprogram/utils/relay.js` 中的 relay URL：

```javascript
function getRelayUrl() {
  return wx.getStorageSync('relay_url') || 'wss://你的域名.com/ws'
}
```

---

## 五、用户使用流程

### 服务器管理员（你）

1. 部署完 relay 后，记住 RELAY_KEY
2. 把以下信息给用户：
   - Relay 地址：`wss://你的域名.com/ws`
   - Relay 密钥：`生成的64位hex密钥`

### 普通用户

```bash
# 安装并运行 connector
npx codemind-connect --relay wss://你的域名.com/ws --key 你的RELAY_KEY

# 终端显示 6 位配对码，在微信小程序输入即可
```

---

## 六、管理命令

```bash
# 查看 relay 状态
pm2 status codemind-relay

# 查看日志
pm2 logs codemind-relay

# 重启 relay
pm2 restart codemind-relay

# 查看密钥
cat /etc/codemind-relay.env

# 更新代码后
cd /opt/codemind-relay && npm install --production && pm2 restart codemind-relay
```

---

## 架构图

```
用户电脑                              服务器(宝塔)                        微信小程序
┌──────────┐     WebSocket      ┌─────────────────┐    wss://     ┌──────────┐
│ hapi hub │ ─────────────────→ │ Relay (Node.js)  │ ←────────── │ MiniProg │
│ (本地)   │   connector 进程   │ 127.0.0.1:3010  │  Nginx 443  │          │
└──────────┘                    └─────────────────┘             └──────────┘
                                       ↑
                                  PM2 守护进程
```
