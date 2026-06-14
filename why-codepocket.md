# Why CodePocket?

Claude Code 是目前最强的终端 AI 编程工具。但它绑在电脑上——离开工位就失去控制力。CodePocket 解决一个简单的问题：**让手机成为 Claude Code 的远程控制台。**

## TL;DR

| 维度 | 直接用 Claude Code | 用 CodePocket |
|------|-------------------|---------------|
| **控制** | 必须坐在电脑前 | 手机随时操控 |
| **权限审批** | 终端按 y/n | 手机一键审批 |
| **离开工位** | AI 等你回来 | YOLO 模式自动审批，或手机远程审批 |
| **手机能力** | Claude 无法访问 | GPS、日历、剪贴板、地图—all as tools |
| **会话管理** | 终端内切换 | 手机上创建/恢复/删除会话 |
| **消息查看** | 终端滚动 | 手机端缓存、分页、富文本渲染 |
| **分享** | 复制粘贴 | Canvas 生成精美分享图 |

## 核心问题

Claude Code 的工作流有一个断裂：

```
你在电脑前 ──► 编码、调试、迭代
     │
     │  离开工位（吃饭、通勤、休息）
     ▼
  AI 卡在权限审批 ──► 等你回来 ──► 浪费数小时
```

CodePocket 补上这个断裂：

```
你在电脑前 ──► 正常编码
     │
     │  离开工位
     ▼
  手机收到审批请求 ──► 一键通过 ──► AI 继续工作
     │
     │  或者开启 YOLO 模式
     ▼
  AI 全自动运行 ──► 手机随时查看进度
```

## 不只是远程终端

远程终端（SSH、tmux）只是"在手机上看电脑屏幕"。CodePocket 不走这条路。它把 AI 编程体验**原生地**搬到手机上：

### 手机作为传感器

Claude Code 运行在电脑上，无法访问手机的 GPS、日历、剪贴板。CodePocket 通过 MCP（Model Context Protocol）把这些能力暴露给 Claude：

```
Claude Code ──(MCP)──► Connector ──(WebSocket)──► Relay ──(WebSocket)──► 小程序 ──(wx API)──► 手机
```

当 Claude 需要获取位置、添加日历事件、写入剪贴板时，它调用 MCP 工具，请求流经 Relay 到达小程序，小程序调用微信原生 API 执行，结果原路返回。

**这意味着**：Claude 可以在你的手机上设置提醒、读取位置来测试地图应用、把代码片段推送到剪贴板。电脑上的 AI 获得了手机的原生能力。

### 可用的手机工具

| 工具 | 能力 |
|------|------|
| `phone_calendar_add` | 添加系统日历事件 |
| `phone_calendar_query` | 查询日历事件 |
| `phone_todo_add/list/complete` | 待办事项管理 |
| `phone_location_get` | 获取当前 GPS 坐标 |
| `phone_location_track/stop` | 持续追踪运动轨迹 |
| `phone_notification_send` | 发送通知 |
| `phone_clipboard_write` | 写入剪贴板 |
| `phone_map_show` | 在手机上展示地图标记 |

## 架构

### 为什么是五层？

```
微信小程序 (CodePocket)
      ↕  WebSocket（小程序只能发起出站 WSS）
  Relay 中继服务器（Bun + Hono）
      ↕  WebSocket（电脑也在 NAT 后面）
  Connector CLI（本地 Node）
      ↕  HTTP + SSE
  Hub（cpkt-hub 二进制）
      ↕  SDK/child_process
  Claude Code
```

每一层都解决一个具体问题：

| 层 | 解决什么 |
|----|---------|
| **小程序** | 手机原生入口，微信生态内即开即用 |
| **Relay** | 穿透 NAT——小程序和电脑都在防火墙后面，需要一个公网中转 |
| **Connector** | 桥接——把 Relay 的 WebSocket 协议翻译成 Hub 的 HTTP/SSE 协议 |
| **Hub** | 进程管理——管理 Claude Code 子进程的生命周期 |
| **Claude Code** | 实际干活 |

### 为什么不能更简单？

**不能去掉 Relay**：用户的电脑在 NAT 后面，微信小程序只能发起出站的 HTTPS/WSS 连接。两端都无法被对方直接访问，公网中转是唯一的解法。

**不能去掉 Connector**：Hub 用 HTTP + SSE 通信，Relay 用 WebSocket。需要一个桥接进程做协议转换，同时管理 MCP 服务器和 Hub 子进程。

**不能去掉 Hub**：Claude Code 不是 HTTP 服务，它是一个终端交互程序。Hub 把 Claude Code 包裹成 HTTP API + SSE 事件流，使远程控制成为可能。

### REST-over-WebSocket 隧道

小程序无法直接访问用户本地的 Hub API。CodePocket 的解法是 REST-over-WebSocket 隧道：

```
小程序发出: { type: "rest-request", requestId: "abc", method: "POST", path: "/api/sessions/123/messages", body: {...} }
     │
     ▼  Relay 原样转发
     │
Connector 收到后执行真正的 HTTP 请求: POST http://localhost:3006/api/sessions/123/messages
     │
     ▼  拿到响应后回传
     │
小程序收到: { type: "rest-response", requestId: "abc", status: 200, data: {...} }
```

`requestId` 把异步的 WebSocket 消息关联成 Promise 化的请求-响应对。小程序端的 `relay.restRequest()` 调用就像发 HTTP 请求一样简单，底层是 WebSocket 隧道。

## 设计决策

### 为什么用 WeChat 小程序而不是 Web App？

| 维度 | Web App（H5） | WeChat 小程序 |
|------|-------------|--------------|
| 打开方式 | 输入 URL 或扫码 | 微信内一键打开 |
| 原生能力 | 受限（浏览器沙箱） | 日历、剪贴板、地图、定位等原生 API |
| 推送 | 需要 PWA/Service Worker | 微信模板消息 |
| 分发 | URL | 微信内分享 |
| 离线体验 | 需要额外实现 | 本地存储开箱即用 |

对于"手机上随时操控 AI"这个场景，微信小程序的触达成本最低——中国用户几乎都在微信里。

### 为什么 Relay 是纯转发？

Relay 服务器只做一件事：把客户端 A 的消息原样转发给客户端 B。它不解析消息内容，不存储数据，不做业务逻辑。

```
设计原则: Relay 是管道，不是数据库。

    ┌─────────┐     原样转发     ┌─────────┐
    │  手机    │ ◄──────────────► │  电脑    │
    │         │      Relay       │         │
    └─────────┘                  └─────────┘
         │                           │
         │  消息内容对 Relay 不可见    │
         │  (未来可加 E2E 加密)       │
         ▼                           ▼
    只有两端能理解消息含义
```

这意味着：
- Relay 部署简单（无状态，无数据库）
- 安全边界清晰（Relay 不接触业务数据）
- 可扩展（未来加端到端加密，Relay 不用改）

### 为什么用 Canvas 渲染分享图？

微信小程序没有 DOM。要把对话渲染成图片分享，唯一的路径是 Canvas 2D API。CodePocket 实现了一个完整的两阶段渲染引擎：

```
阶段 1: 布局（Layout）
  - 计算每个 block 的位置和尺寸
  - 文字换行、代码块、表格、卡片
  - 生成绘制指令列表

阶段 2: 绘制（Paint）
  - 遍历指令列表，调用 Canvas API
  - 多主题支持（纸张风、薄雾、蜜桃、暗黑）
  - 安全高度上限（8000px）
```

结果是：用户可以一键把对话生成为精美的图片分享到微信，而不需要截图拼接。

### 为什么 MCP 服务器内嵌在 Connector 里？

Connector 已经是一个 Node.js 长驻进程。如果把 MCP 服务器做成独立进程，就需要管理另一个子进程的生命周期、端口分配、健康检查。内嵌在 Connector 里：

- 共享 Relay 连接（不需要第二条 WebSocket）
- 共享进程生命周期（Connector 挂了，MCP 服务器也挂了，合理）
- 自动端口发现（3007-3016），自动注入 Claude Code 配置

### 为什么用 Key 配对 + 持久令牌？

配对流程从手机端发起：

```
首次使用:
  1. 手机: 打开小程序，自动向 Relay 注册（绑定微信 OpenID，去重），获取唯一 Key
  2. 手机: 显示一行安装命令: npm i -g @tina_summer/codepocket && codepocket --key YOUR_KEY
  3. 用户: 复制命令到终端执行，一键完成安装 + 启动 + 连接
  4. Relay: Key 匹配，两端建立信任，交换持久令牌（client_token / session_token）

后续使用:
  电脑: codepocket（自动启动，用令牌重连）
  手机: 打开小程序（自动连接，用令牌重连）
  结果: 无需操作，自动恢复连接

重新配对:
  手机: 设置页 → "重新配对" → 清除旧 Key 和令牌 → 重新注册新 Key
```

设计选择：
- **Key 由手机端生成而非电脑端**：小程序界面比终端更适合展示引导流程，用户只需复制一行命令
- **Key 绑定微信 OpenID**：同一用户永远获得同一个 Key，卸载重装不会产生重复 Key
- **一次命令完成全部操作**：`npm i -g` + `codepocket --key` 合并，零学习成本
- **持久令牌免重复配对**：后续启动双方自动用令牌重连，Relay 支持断线延迟清理（5 分钟内重连可复用会话）

## 总结

CodePocket 存在的原因可以归结为一句话：

> **Claude Code 绑定在终端上，但开发者不是。**

通过五层架构（小程序 → Relay → Connector → Hub → Claude Code），CodePocket 让开发者用手机控制远程的 AI 编程会话。不只是"远程终端"——手机的原生能力（GPS、日历、剪贴板）通过 MCP 暴露给 Claude，使 AI 获得了超越电脑边界的感知力。

每一个架构决策都服务于这个目标：微信小程序触达成本最低，Relay 穿透 NAT，Connector 桥接协议，Hub 管理进程，Claude Code 干活。没有多余的一层。
