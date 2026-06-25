#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════
# CodePocket Relay — 服务器端一键部署脚本
#
# 直接在服务器终端运行:
#   bash server-setup.sh
#
# 不依赖项目源码，所有代码内嵌
# 只安装 relay 服务，不影响其他端口/进程
# ═══════════════════════════════════════════════════════

RELAY_PORT=3010
INSTALL_DIR="/opt/codepocket-relay"

echo "╔══════════════════════════════════════╗"
echo "║  CodePocket Relay 服务器部署           ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── 1. Node.js (via nvm, 兼容所有 Linux) ──

echo "[1/4] 检查 Node.js..."

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if ! command -v node &>/dev/null; then
  echo "  安装 nvm + Node.js 20..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 20
  nvm use 20
  NODE_BIN="$(nvm which current)"
  sudo ln -sf "$NODE_BIN" /usr/local/bin/node 2>/dev/null || true
  sudo ln -sf "$(dirname "$NODE_BIN")/npm" /usr/local/bin/npm 2>/dev/null || true
  sudo ln -sf "$(dirname "$NODE_BIN")/npx" /usr/local/bin/npx 2>/dev/null || true
fi

[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
echo "  Node: $(node -v)"

# ── 2. 代码 + 依赖 ──

echo "[2/4] 部署代码..."

sudo mkdir -p "$INSTALL_DIR/src" "$INSTALL_DIR/data"

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

# Inline relay source (matches relay/src/index.js)
cat "$INSTALL_DIR/src/index.js" 2>/dev/null | head -1 | grep -q "CodePocket" && echo "  源码已存在，跳过" || {
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

  if [[ -f "$PROJECT_DIR/relay/src/index.js" ]]; then
    sudo cp "$PROJECT_DIR/relay/src/index.js" "$INSTALL_DIR/src/index.js"
    echo "  已复制 relay/src/index.js"
  else
    echo "  [!] 未找到 relay/src/index.js"
    echo "  请确保项目已 clone 到服务器，或手动复制"
    exit 1
  fi
}

cd "$INSTALL_DIR"
sudo npm install --production --omit=dev 2>&1 | tail -3
echo "  依赖安装完成"

# ── 3. 密钥 ──

echo "[3/4] 生成密钥..."

ADMIN_KEY=$(openssl rand -hex 32)

sudo tee /etc/codepocket-relay.env > /dev/null <<EOF
RELAY_PORT=$RELAY_PORT
ADMIN_KEY=$ADMIN_KEY
DATA_DIR=$INSTALL_DIR/data
NODE_ENV=production
EOF
sudo chmod 600 /etc/codepocket-relay.env
echo "  管理员密钥已保存"

# ── 4. PM2 启动 ──

echo "[4/4] 启动服务..."

if ! command -v pm2 &>/dev/null; then
  echo "  安装 PM2..."
  sudo npm install -g pm2
fi

pm2 delete codepocket-relay 2>/dev/null || true

cd "$INSTALL_DIR"
export $(cat /etc/codepocket-relay.env | xargs)
pm2 start src/index.js --name codepocket-relay

pm2 save 2>/dev/null
pm2 startup 2>/dev/null | tail -1 | sudo bash 2>/dev/null || true

sleep 1
echo ""

# ── 验证 ──

if curl -s "http://127.0.0.1:$RELAY_PORT/" 2>/dev/null | grep -q "codepocket-relay"; then
  echo "  ✓ Relay 启动成功"

  # 获取自动生成的默认用户 key
  DEFAULT_KEY=$(curl -s -H "Authorization: Bearer $ADMIN_KEY" "http://127.0.0.1:$RELAY_PORT/admin/keys" | python3 -c "import sys,json; keys=json.load(sys.stdin)['keys']; print(keys[0].get('key_full',''))" 2>/dev/null || echo "")
else
  echo "  ✗ 启动失败，查看日志: pm2 logs codepocket-relay"
  exit 1
fi

# ── 结果 ──

echo ""
echo "════════════════════════════════════════════════"
echo "  部署完成!"
echo "════════════════════════════════════════════════"
echo ""
echo "  ⚠️  管理员密钥 (请立即保存，用于管理用户):"
echo ""
echo "  $ADMIN_KEY"
echo ""
echo "  ─────────────────────────────────────────"
echo ""
echo "  管理用户 (无需重启服务):"
echo ""
echo "  # 添加用户"
echo "  curl -X POST http://127.0.0.1:$RELAY_PORT/admin/keys \\"
echo "    -H 'Authorization: Bearer $ADMIN_KEY' \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"name\": \"用户名\"}'"
echo ""
echo "  # 查看所有用户"
echo "  curl -H 'Authorization: Bearer $ADMIN_KEY' \\"
echo "    http://127.0.0.1:$RELAY_PORT/admin/keys"
echo ""
echo "  # 吊销用户 (替换 KEY_ID)"
echo "  curl -X DELETE -H 'Authorization: Bearer $ADMIN_KEY' \\"
echo "    http://127.0.0.1:$RELAY_PORT/admin/keys/KEY_ID"
echo ""
echo "  ─────────────────────────────────────────"
echo ""
echo "  接下来在宝塔面板操作:"
echo ""
echo "  1. 网站 → 添加站点 → 填域名 → PHP选纯静态"
echo "  2. 站点 → SSL → 确保证书已部署"
echo "  3. 站点 → 反向代理 → 添加 → 目标 http://127.0.0.1:$RELAY_PORT"
echo "  4. 反向代理 → 自定义配置 → 粘贴以下内容:"
echo ""
echo "  ─────────────────────────────────"

sudo tee "$INSTALL_DIR/nginx-proxy.conf" > /dev/null << 'NGXEOF'
location ^~ /ws {
    proxy_pass http://127.0.0.1:3010;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location / {
    proxy_pass http://127.0.0.1:3010;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
NGXEOF

cat "$INSTALL_DIR/nginx-proxy.conf"
echo "  ─────────────────────────────────"
echo ""
echo "  管理命令:"
echo "    pm2 status codepocket-relay      # 状态"
echo "    pm2 logs codepocket-relay        # 日志"
echo "    pm2 restart codepocket-relay     # 重启"
echo ""
