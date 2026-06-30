# CodePocket Connector

CodePocket 的本地连接器，让你的手机通过微信小程序远程控制 Claude Code。

## 前提条件

- 电脑已安装 [Claude Code CLI](https://claude.ai)（终端运行 `claude` 验证）
- Node.js 18+

## 安装

```bash
npm i -g @tina_summer/codepocket
```

npm 包已内置 Hub 二进制（macOS / Linux / Windows），无需额外下载。如需手动更新 Hub，可运行 `codepocket install-hub`。

## 使用

### 首次配对

在微信小程序配对页获取你的 Key，然后运行：

```bash
codepocket --key YOUR_KEY
```

命令会自动：
1. 保存 Key 到 `~/.codepocket/config.json`
2. 启动 Hub 并连接 Relay
3. 启动 Claude Code（等同于直接运行 `claude`）

配对成功后小程序自动跳转。

### 后续使用

```bash
codepocket
```

无需再加 `--key`，自动连接上次配对的 Relay。

### 命令一览

| 命令 | 说明 |
|------|------|
| `codepocket` | 启动 Claude Code + 连接手机 |
| `codepocket --key YOUR_KEY` | 首次配对 |
| `codepocket start` | 后台守护模式（不启动 Claude Code） |
| `codepocket stop` | 停止后台守护进程 |
| `codepocket status` | 查看运行状态 |
| `codepocket logs` | 查看日志 |
| `cpkt` | 短命令，等同于 `codepocket` |

## 手机端功能

通过小程序可以：

- **远程对话** — 发消息、查看实时回复和思考过程
- **权限审批** — 一键批准/拒绝 Claude 的工具调用
- **会话管理** — 新建、恢复、中止、归档会话
- **浏览目录** — 选择电脑上的目录启动新会话
- **YOLO 模式** — 全自动审批，无人值守运行
- **手机工具** — GPS、日历、剪贴板、地图等原生能力通过 MCP 暴露给 Claude

## 可选：CC-Switch

[CC-Switch](https://github.com/farion1231/cc-switch) 是管理 Claude Code 多 API 密钥/中转服务商的切换工具，下载地址：[Releases](https://github.com/farion1231/cc-switch/releases/latest)

## 开源

本仓库（Connector）开源在 [github.com/TinaSummer/CodePocket](https://github.com/TinaSummer/CodePocket)。

## License

MIT
