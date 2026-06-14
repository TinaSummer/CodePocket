#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════
# CodePocket Relay — 一键更新脚本
#
# 在服务器上运行:
#   bash update.sh
#
# 从 GitHub 拉取最新代码，更新 relay，保留数据和配置
# ═══════════════════════════════════════════════════════

INSTALL_DIR="/opt/codepocket-relay"
REPO_DIR="/root/codepocket"
REPO_URL="https://github.com/TinaSummer/codepocket.git"

echo "╔══════════════════════════════════════╗"
echo "║  CodePocket Relay 更新                 ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── 1. 拉取最新代码 ──

echo "[1/3] 拉取最新代码..."

if [[ ! -d "$REPO_DIR" ]]; then
  echo "  首次 clone..."
  git clone "$REPO_URL" "$REPO_DIR"
else
  cd "$REPO_DIR"
  git pull
fi

echo "  ✓ 代码已更新"

# ── 2. 复制新代码 ──

echo "[2/3] 更新 relay..."

sudo cp "$REPO_DIR/relay/src/index.node.js" "$INSTALL_DIR/src/index.js"

cd "$INSTALL_DIR"

# 检查 package.json 是否有变化，有则更新依赖
OLD_PKG=$(md5sum package.json 2>/dev/null | cut -d' ' -f1)
sudo cp "$REPO_DIR/scripts/server-setup.sh" /tmp/_pkg_check.sh 2>/dev/null || true

# 更新 package.json 中的依赖版本
sudo tee "$INSTALL_DIR/package.json" > /dev/null <<'PKGEOF'
{
  "name": "codepocket-relay",
  "version": "2.0.0",
  "private": true,
  "scripts": { "start": "node src/index.js" },
  "dependencies": {
    "hono": "^4.7.0",
    "@hono/node-ws": "^1.3.0",
    "@hono/node-server": "^1.13.0"
  }
}
PKGEOF

NEW_PKG=$(md5sum package.json 2>/dev/null | cut -d' ' -f1)

if [[ "$OLD_PKG" != "$NEW_PKG" ]]; then
  echo "  依赖有变化，安装中..."
  sudo npm install --omit=dev 2>&1 | tail -3
else
  echo "  依赖无变化，跳过"
fi

# 复制管理脚本
sudo cp "$REPO_DIR/scripts/manage.sh" "$INSTALL_DIR/manage.sh" 2>/dev/null && chmod +x "$INSTALL_DIR/manage.sh" || true

echo "  ✓ 代码已更新"

# ── 3. 重启服务 ──

echo "[3/3] 重启服务..."

pm2 restart codepocket-relay

sleep 1

if curl -s http://127.0.0.1:3010/ 2>/dev/null | grep -q "codepocket-relay"; then
  VERSION=$(curl -s http://127.0.0.1:3010/ 2>/dev/null | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
  echo "  ✓ Relay v$VERSION 运行中"
else
  echo "  ✗ 启动失败，查看日志: pm2 logs codepocket-relay"
  exit 1
fi

echo ""
echo "  更新完成!"
echo ""
