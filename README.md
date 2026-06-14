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

## 快速开始

### 1. 安装 CLI

```bash
npm i -g @tina_summer/codepocket
```

### 2. 启动

```bash
codepocket
```

首次运行会提示输入 Key（在 CodePocket 小程序中获取），之后只需 `codepocket` 一条命令自动连接 + 启动 Claude Code。

```bash
# 首次带 Key 启动
codepocket --key YOUR_KEY

# 自定义 Relay 地址
codepocket --relay wss://example.com/ws

# 短命令
cpkt
```

### 3. Daemon 模式

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

## 项目结构

```
codepocket/
├── connector/        # npm CLI 包 (@tina_summer/codepocket)
│   ├── bin/          # CLI 入口
│   ├── src/          # MCP server、connector 逻辑
│   └── vendor/       # Hub 二进制
├── miniprogram/      # 微信小程序
├── relay/            # Relay 中继服务器 (Bun + Hono)
├── proxy/            # 代理服务
├── scripts/          # 部署/管理脚本
└── docs/             # 部署文档
```

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
2. 导入 `codepocket/` 目录
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
