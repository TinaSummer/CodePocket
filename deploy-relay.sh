#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════
# CodePocket Relay 一键部署脚本 (Nginx 版)
#
# 用法:
#   bash deploy-relay.sh --domain your-domain.com
#
# 安全措施:
#   - RELAY_KEYS 管理员密钥 (用于 /admin API, 自动生成)
#   - 独立系统用户运行 relay (无 shell, 无 home)
#   - Nginx WebSocket 连接频率限制
#   - 绑定 127.0.0.1, 不对外暴露端口
# ═══════════════════════════════════════════════════════

DOMAIN=""
RELAY_PORT=3010
INSTALL_DIR="/opt/codepocket-relay"
RELAY_USER="codepocket-relay"
SSL_CERT=""
SSL_KEY=""
RELAY_KEYS=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --domain)     DOMAIN="$2"; shift 2 ;;
    --port)       RELAY_PORT="$2"; shift 2 ;;
    --dir)        INSTALL_DIR="$2"; shift 2 ;;
    --ssl-cert)   SSL_CERT="$2"; shift 2 ;;
    --ssl-key)    SSL_KEY="$2"; shift 2 ;;
    --key)        RELAY_KEYS="$2"; shift 2 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

if [[ -z "$DOMAIN" ]]; then
  echo "用法: bash deploy-relay.sh --domain your-domain.com [--key SECRET]"
  echo ""
  echo "参数:"
  echo "  --domain     你的域名 (必须已解析到本服务器)"
  echo "  --port       Relay 端口 (默认 3010)"
  echo "  --key        Relay 管理员密钥 (不填则自动生成,仅用于 /admin API)"
  echo "  --ssl-cert   SSL 证书路径 (可选, 不填则用 certbot)"
  echo "  --ssl-key    SSL 私钥路径 (可选)"
  exit 1
fi

# Auto-generate key if not provided
if [[ -z "$RELAY_KEYS" ]]; then
  RELAY_KEYS=$(openssl rand -hex 32)
fi

echo "╔══════════════════════════════════════╗"
echo "║   CodePocket Relay 部署 (Nginx)    ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "域名: $DOMAIN"
echo "端口: $RELAY_PORT (仅 127.0.0.1)"
echo "目录: $INSTALL_DIR"
echo "用户: $RELAY_USER"
echo "管理员密钥: ${RELAY_KEYS:0:8}... (完整值在部署结束后输出)"
echo ""

# ── 1. 系统依赖 ──

echo "[1/6] 安装系统依赖..."

if command -v apt-get &>/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq curl unzip nginx
elif command -v yum &>/dev/null; then
  sudo yum install -y -q curl unzip nginx
fi

echo "  Nginx: $(nginx -v 2>&1)"

# ── 2. Bun ──

echo "[2/6] 安装 Bun..."

if ! command -v bun &>/dev/null; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc
fi

echo "  Bun: $(bun --version)"

# ── 3. 独立用户 + 目录 ──

echo "[3/6] 创建隔离用户..."

if ! id "$RELAY_USER" &>/dev/null; then
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin "$RELAY_USER"
  echo "  用户 $RELAY_USER 已创建"
else
  echo "  用户 $RELAY_USER 已存在"
fi

sudo mkdir -p "$INSTALL_DIR/src"

# Copy relay source from local project
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$SCRIPT_DIR/relay/src/index.js" ]]; then
  sudo cp "$SCRIPT_DIR/relay/src/index.js" "$INSTALL_DIR/src/index.js"
  sudo cp "$SCRIPT_DIR/relay/package.json" "$INSTALL_DIR/package.json"
else
  # Inline fallback
  sudo tee "$INSTALL_DIR/package.json" > /dev/null <<'PKGJSON'
{
  "name": "codepocket-relay",
  "version": "1.0.0",
  "private": true,
  "scripts": { "start": "bun run src/index.js" },
  "dependencies": { "hono": "^4.7.0" }
}
PKGJSON

  echo "[!] 本地 relay 源码未找到，请手动复制 relay/src/index.js 到 $INSTALL_DIR/src/"
  exit 1
fi

cd "$INSTALL_DIR" && bun install --production
sudo chown -R "$RELAY_USER:$RELAY_USER" "$INSTALL_DIR"

# ── 4. Relay systemd 服务 ──

echo "[4/6] 配置 Relay 服务..."

BUN_PATH=$(command -v bun)

# Store key in env file (root-only readable)
sudo tee "/etc/codepocket-relay.env" > /dev/null <<EOF
RELAY_PORT=$RELAY_PORT
RELAY_KEYS=$RELAY_KEYS
NODE_ENV=production
EOF
sudo chmod 600 /etc/codepocket-relay.env
sudo chown root:root /etc/codepocket-relay.env

sudo tee /etc/systemd/system/codepocket-relay.service > /dev/null <<EOF
[Unit]
Description=CodePocket Relay
After=network.target

[Service]
Type=simple
User=$RELAY_USER
Group=$RELAY_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$BUN_PATH run src/index.js
Restart=always
RestartSec=3
EnvironmentFile=/etc/codepocket-relay.env
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable codepocket-relay
sudo systemctl restart codepocket-relay

echo "  Relay 服务已启动 (用户: $RELAY_USER, 仅 127.0.0.1:$RELAY_PORT)"

# ── 5. Nginx + HTTPS + 限流 ──

echo "[5/6] 配置 Nginx..."

# Add rate limiting zone to nginx.conf (only once)
if ! grep -q "codepocket_ws_limit" /etc/nginx/nginx.conf 2>/dev/null; then
  # Insert limit_req_zone in http block
  sudo sed -i '/http {/a\\t# CodePocket WebSocket rate limiting\n\tlimit_req_zone \$binary_remote_addr zone=codepocket_ws_limit:10m rate=30r/m;\n\tlimit_req_zone \$binary_remote_addr zone=codepocket_api_limit:10m rate=60r/m;\n' /etc/nginx/nginx.conf
  echo "  Nginx 限流规则已添加"
fi

# certbot for SSL
if [[ -z "$SSL_CERT" || -z "$SSL_KEY" ]]; then
  if ! command -v certbot &>/dev/null; then
    echo "  安装 certbot..."
    if command -v apt-get &>/dev/null; then
      sudo apt-get install -y -qq certbot python3-certbot-nginx
    elif command -v yum &>/dev/null; then
      sudo yum install -y -q certbot python3-certbot-nginx
    fi
  fi

  # HTTP-only config first for certbot verification
  sudo tee /etc/nginx/sites-available/$DOMAIN > /dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    location / { proxy_pass http://127.0.0.1:$RELAY_PORT; }
}
EOF
  sudo ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN
  sudo nginx -t 2>/dev/null && sudo systemctl reload nginx

  echo "  申请 SSL 证书..."
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email 2>/dev/null || {
    echo "  [!] certbot 失败，当前为 HTTP 模式"
    echo "  后续手动配置: sudo certbot --nginx -d $DOMAIN"
  }
fi

# Full Nginx config with security hardening
CERT_LINE="${SSL_CERT:+ssl_certificate $SSL_CERT;}"
KEY_LINE="${SSL_KEY:+ssl_certificate_key $SSL_KEY;}"
CERT_DEFAULT="${CERT_LINE:-ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;}"
KEY_DEFAULT="${KEY_LINE:-ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;}"

sudo tee /etc/nginx/sites-available/$DOMAIN > /dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    $CERT_DEFAULT
    $KEY_DEFAULT

    # Security headers
    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options DENY;

    # WebSocket — rate limited
    location /ws {
        limit_req zone=codepocket_ws_limit burst=5 nodelay;
        proxy_pass http://127.0.0.1:$RELAY_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # REST API — rate limited
    location / {
        limit_req zone=codepocket_api_limit burst=20 nodelay;
        proxy_pass http://127.0.0.1:$RELAY_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN
sudo nginx -t && sudo systemctl reload nginx

sudo systemctl enable certbot.timer 2>/dev/null || true

# ── 6. 健康检查 ──

echo "[6/6] 健康检查..."
sleep 2  # 给 relay 一点时间启动 + 绑定端口

CHECKS_OK=true

# 6.1 systemd 服务在跑(没在跑通常是 env var / 依赖问题)
if systemctl is-active --quiet codepocket-relay; then
  echo "  ✓ relay 服务运行中"
else
  echo "  ✗ relay 服务未启动 — 查日志:"
  echo "    sudo journalctl -u codepocket-relay -n 30 --no-pager"
  echo "  常见原因: /etc/codepocket-relay.env 里变量名拼错(必须是 RELAY_KEYS 不是 RELAY_KEY)"
  CHECKS_OK=false
fi

# 6.2 本地端口响应(GET / 返回 {ok:true})
if curl -sf http://127.0.0.1:$RELAY_PORT/ >/dev/null 2>&1; then
  echo "  ✓ relay 本地端口 127.0.0.1:$RELAY_PORT 响应正常"
else
  echo "  ✗ relay 本地端口无响应 — 查日志: sudo journalctl -u codepocket-relay -n 30"
  CHECKS_OK=false
fi

# 6.3 公网 URL 走 nginx 反代能通(DNS 未生效/证书申请失败时降级为 warning)
PUBLIC_OK=false
for i in 1 2 3; do
  if curl -sf https://$DOMAIN/ >/dev/null 2>&1; then
    PUBLIC_OK=true
    break
  fi
  sleep 2
done
if $PUBLIC_OK; then
  echo "  ✓ 公网地址 https://$DOMAIN 响应正常"
else
  echo "  ⚠ 公网地址暂未响应(可能是 DNS 未生效 / SSL 证书还在申请)"
  echo "    稍后手动测试: curl https://$DOMAIN/"
  echo "    若长期不通,查 nginx: sudo nginx -t && sudo tail -20 /var/log/nginx/error.log"
fi

if ! $CHECKS_OK; then
  echo ""
  echo "  ⚠ 基础检查未通过,relay 不可用。修好上面 ✗ 标出的问题后再继续。"
  exit 1
fi

echo ""
echo "════════════════════════════════════════"
echo "  部署完成!"
echo "════════════════════════════════════════"
echo ""
echo "  Relay:     https://$DOMAIN"
echo "  WebSocket: wss://$DOMAIN/ws"
echo ""
echo "  安全配置:"
echo "    - 运行用户: $RELAY_USER (无 shell)"
echo "    - 端口绑定: 127.0.0.1:$RELAY_PORT (仅 Nginx 可访问)"
echo "    - systemd 沙箱: ProtectSystem/ProtectHome/PrivateTmp"
echo "    - Nginx 限流: WebSocket 30次/分, API 60次/分"
echo "    - 密钥文件: /etc/codepocket-relay.env (root:root, 600)"
echo ""
echo "  ⚠️  管理员密钥 (仅用于 /admin API, 客户端连接不需要):"
echo "  $RELAY_KEYS"
echo "  (忘记可执行: cat /etc/codepocket-relay.env)"
echo ""
echo "  ── 客户端连接流程 ──"
echo "  1. 微信小程序 → 设置 → Relay 地址 → 填入 wss://$DOMAIN/ws"
echo "  2. 回到小程序首页,会自动申请 user key 并显示完整连接命令"
echo "  3. 把小程序显示的命令复制到电脑终端运行(命令里的 key 由小程序申请,不是上面的管理员密钥)"
echo ""
echo "  示例命令(key 由小程序自动生成,不要填管理员密钥):"
echo "    codepocket --relay wss://$DOMAIN/ws --key <小程序显示的Key>"
echo ""
echo "  管理命令:"
echo "    systemctl status codepocket-relay"
echo "    journalctl -u codepocket-relay -f"
echo "    cat /etc/codepocket-relay.env          # 查看密钥"
echo "    nginx -t && systemctl reload nginx"
echo ""
