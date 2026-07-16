# CodePocket

你的全能 AI 随身控制台 — 在手机上远程控制 Claude Code。

微信小程序搜索 **CodePocket** 即可使用。

## 功能

- **远程对话** — 手机上发送消息、查看 Markdown 渲染结果、实时流式输出
- **会话管理** — 查看所有 AI 编程会话，新建/恢复/终止会话
- **权限审批** — 一键批准/拒绝 Claude 的工具调用请求
- **YOLO 模式** — 自动批准所有权限请求，无人值守
- **工具箱** — 日历、Todo、GPS 轨迹、快捷指令、AI 识图
- **文件预览** — 在线预览 Claude 生成的代码和文件
- **分享对话** — 一键导出对话记录，生成分享链接
- **Daemon 模式** — 后台常驻运行，开机自启
- **自部署 Relay** — 用户可部署自己的 Relay 服务器，小程序中填入地址即可使用
- **端到端加密** — X25519 + XSalsa20-Poly1305，Relay 服务器只转发密文，无法解密内容
- **代理支持** — 自动识别 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量，公司网络可用

## 快速开始

### 1. 安装 CLI

```bash
npm i -g @tina_summer/codepocket
```

npm 包已通过 `optionalDependencies` 内置四个平台的 Hub 二进制（macOS arm64/x64、Linux x64、Windows x64），安装时自动选择对应平台，无需额外下载。如需手动更新或修复 Hub，可运行 `codepocket install-hub` 从 GitHub Releases 重新下载。

### 2. 启动

```bash
codepocket
```

首次运行会提示输入 Key（在 CodePocket 小程序中获取），之后只需 `codepocket` 一条命令自动连接 + 启动 Claude Code。

```bash
# 首次带 Key 启动
codepocket --key YOUR_KEY

# 自定义 Relay 地址（指向你自部署的 Relay）
codepocket --relay wss://your-domain.com/ws --key YOUR_KEY

# 短命令
cpkt
```

### 4. Daemon 模式

后台常驻运行，关闭终端不中断：

```bash
codepocket start              # 后台启动
codepocket start --key YOUR_KEY  # 带 Key 后台启动
codepocket stop               # 停止
codepocket logs               # 查看日志
codepocket status             # 查看运行状态
```

## 配置

配置文件位于 `~/.codepocket/config.json`，首次运行 `codepocket` 时自动生成。

环境变量：

| 变量 | 说明 |
|---|---|
| `RELAY_WS_URL` | Relay 服务器 WebSocket 地址 |
| `CPKT_HUB_URL` | Hub 服务地址（默认 `http://127.0.0.1:3006`） |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` | 代理地址（公司网络环境下使用） |

## 自部署 Relay

默认情况下小程序连接作者托管的 Relay 服务。如果你希望自己部署一份（数据完全自有），仓库提供了部署脚本。

### 一键部署 (Nginx + systemd)

在你的服务器上：

```bash
git clone https://github.com/TinaSummer/CodePocket.git
cd CodePocket
bash deploy-relay.sh --domain relay.your-domain.com
```

脚本会自动完成：
- 安装 Nginx + Bun + certbot (Let's Encrypt)
- 创建隔离的系统用户 (`codepocket-relay`，无 shell)
- 配置 systemd 服务（沙箱模式）
- 申请 SSL 证书并配置 WSS 反向代理
- 添加 WebSocket / API 限流规则

部署完成后会输出自动生成的 `RELAY_KEY`。然后在微信小程序的 **设置 → Relay 地址** 中填入 `wss://relay.your-domain.com/ws`，启动 CLI 时也带上：

```bash
codepocket --relay wss://relay.your-domain.com/ws --key YOUR_RELAY_KEY
```

### 其他部署方式

- 宝塔面板:参考 [docs/deploy-baota.md](docs/deploy-baota.md)
- Docker / Caddy:参考 [docker-compose.yml](docker-compose.yml) 和 [Caddyfile](Caddyfile)

## 项目结构

```
CodePocket/
├── connector/        # npm CLI 包 (@tina_summer/codepocket)
│   ├── bin/          # CLI 入口 (codepocket.js)
│   └── src/          # MCP server、connector 逻辑
├── miniprogram/      # 微信小程序客户端 (已上架，可用测试号本地调试)
├── relay/            # Relay 中继服务器 (Bun + Hono)
├── proxy/            # SSE→WebSocket 代理
├── docs/             # 部署文档 (deploy-baota.md 等)
├── deploy-relay.sh   # Relay 一键部署脚本
├── docker-compose.yml # Docker 部署
└── Caddyfile         # Caddy 反代配置
```

> Hub 二进制 (`cpkt-hub`) 通过 `packages/<platform>/bin/` 平台子包随 npm 一起分发，源码不在仓库内。如需手动重装，运行 `codepocket install-hub` 从 GitHub Releases 下载。

### 小程序页面

| 页面 | 说明 |
|---|---|
| 对话列表 | 查看、管理所有 AI 会话 |
| 对话详情 | 消息收发、Markdown 渲染、工具调用卡片、权限审批 |
| 工具箱 | 日历、Todo、GPS 轨迹、快捷指令、AI 识图 |
| 地图 | GPS 轨迹回放、标记点、距离/速度统计 |
| 设置 | 连接状态、壁纸、消息样式、问题排查 |
| 配对引导 | 首次配对流程，4 步引导 |

## 架构

```
微信小程序 (CodePocket)
      ↕  WSS
  Relay 中继服务器
      ↕  WSS
  codepocket CLI (本地)
      ↕  HTTP/SSE
  Hub (cpkt-hub)
      ↕
  Claude Code
```

Relay 是纯转发中间人，负责路由消息。CLI 和小程序通过 Relay 建立双向通信。

## 安全

### 端到端加密（自 v2.6.1 起）

所有经由 Relay 转发的业务消息都端到端加密，Relay 服务器**只看到密文**：

- **密钥协商**：CLI 与小程序在配对时通过 Relay 交换 X25519 临时公钥，各自用 `nacl.box.before()` 派生共享密钥。Relay 看到两个公钥但无法算出共享密钥。
- **加密范围**：会话消息、文件读取、命令输出、SSE 事件、`rest-request`/`spawn-session`/`resume-session`/`list-dir`/`auth-request` 的 body 全部进入 `enc` 信封；只有路由字段（`type`/`requestId`/`status` 等）保持明文。
- **Nonce 设计**：基于计数器 + 方向标签（CLI→手机以 `0xFF` 开头，手机→CLI 以 `0x00` 开头），在同一把共享密钥下避免重用——这一选择也是为了规避小程序 `wx.getRandomValues` 只能异步调用的限制。
- **向后兼容**：旧版 peer 不发 `e2ePubKey` 时自动降级为明文，升级不会断链。
- **重连自动恢复**：hub/CLI/小程序任一重启导致 keypair 轮换后，Relay 在 WebSocket 重连路径上补发双方公钥，下次重连（通常 3 秒内）自动重建 E2E 通道，无需重新配对。详见 [why-codepocket.md](why-codepocket.md#重连时的通道恢复)。

### Relay 侧加固

- `/register` 在托管模式（配置了 `WX_APPID`/`WX_SECRET`）下强制校验微信 `code`，杜绝匿名批量造 Key
- `/share` 上传要求有效 Relay Key，防止匿名 COS 滥用
- `keys.json` 写入权限 `0600`，`DATA_DIR` 权限 `0700`
- 健康检查端点不再暴露连接数/用户数
- WebSocket 限流按 `X-Forwarded-For` / `X-Real-IP` 真实 IP 分桶，避免单 IP 失败拖全用户下水
- 配对错误分类：`hub_offline`（电脑还没连）不计入失败次数，新用户首次不再被误 ban

## 本地开发

### 小程序开发

1. 安装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
2. 导入 `CodePocket/` 目录
3. 复制 `miniprogram/utils/config.js` 为 `miniprogram/utils/config.local.js`，填入你的 Relay 地址
4. AppID 使用 `测试号` 或在 `project.config.json` 中填入你自己的

### CLI 开发

```bash
cd connector
npm install
node bin/codepocket.js --key YOUR_KEY
```

## License

MIT

## 致谢

- [linux.do](https://linux.do) — 感谢社区提供的交流平台与成员们的反馈建议，让这个项目在实际使用场景中不断打磨完善。
