#!/usr/bin/env bash
set -euo pipefail

# 本地开发 - 使用 cloudflared 内网穿透
# 无需服务器，无需备案，快速测试用
#
# 用法:
#   bash dev-tunnel.sh
#
# 前提:
#   1. 已启动 hapi hub (默认 :3006)
#   2. 已安装 cloudflared (brew install cloudflared)

echo "=== CodePocket 本地开发隧道 ==="

# Check cloudflared
if ! command -v cloudflared &>/dev/null; then
  echo "安装 cloudflared..."
  brew install cloudflared
fi

# Start proxy if not running
if ! curl -s http://127.0.0.1:3010/ >/dev/null 2>&1; then
  echo "启动 proxy..."
  cd "$(dirname "$0")/proxy"
  bun run src/index.ts &
  PROXY_PID=$!
  cd ..
  sleep 2
  echo "Proxy started (PID: $PROXY_PID)"
fi

# Create tunnel
echo "创建 Cloudflare 隧道..."
echo ""
echo "访问地址将在下方显示，格式如: https://xxx-xxx.trycloudflare.com"
echo ""
echo "⚠️  注意：这是临时地址，每次重启会变化"
echo "⚠️  微信小程序正式发布需要备案域名，这个只用于开发调试"
echo ""
echo "小程序开发工具中: 关闭「不校验合法域名」选项后可用"
echo ""

cloudflared tunnel --url http://127.0.0.1:3010
