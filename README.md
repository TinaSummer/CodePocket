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
- **代理支持** — 自动识别 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量，公司网络可用

## 快速开始

### 1. 安装 CLI

```bash
npm i -g @tina_summer/codepocket
```

npm 包已内置 Hub 二进制（macOS / Linux / Windows），无需额外下载。

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

> Hub 二进制 (`cpkt-hub`) 通过 GitHub Releases 分发，不在仓库内。运行 `codepocket install-hub` 自动下载。

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
