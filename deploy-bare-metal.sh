#!/usr/bin/env bash
set -euo pipefail

# CodePocket 裸机部署脚本
# 适用于: 没有 Docker 的 VPS / 云服务器
# 需要: Ubuntu 22.04+ / Debian 12+ / CentOS 8+
#
# 用法:
#   curl -fsSL https://your-server/deploy.sh | bash -s -- --domain example.com --email you@example.com
#   或者本地运行: bash deploy-bare-metal.sh --domain example.com --email you@example.com

DOMAIN=""
EMAIL=""
HUB_PORT=3006
PROXY_PORT=3010

while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --hub-port) HUB_PORT="$2"; shift 2 ;;
    --proxy-port) PROXY_PORT="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$DOMAIN" ]]; then
  echo "Usage: $0 --domain your-domain.com [--email you@example.com]"
  exit 1
fi

echo "=== CodePocket 部署 ==="
echo "Domain: $DOMAIN"
echo "Hub port: $HUB_PORT, Proxy port: $PROXY_PORT"
echo ""

# 1. Install dependencies
echo "[1/5] 安装依赖..."
if command -v apt-get &>/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq curl unzip caddy 2>/dev/null || {
    # Caddy not in default repos, install from official
    sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
    sudo apt-get update -qq
    sudo apt-get install -y -qq caddy
  }
elif command -v yum &>/dev/null; then
  sudo yum install -y curl unzip
  # Install Caddy
  sudo yum install -y yum-plugin-copr
  sudo yum copr enable -y @caddy/caddy
  sudo yum install -y caddy
fi

# Install Bun if not present
if ! command -v bun &>/dev/null; then
  echo "[1/5] 安装 Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# 2. Install Hapi CLI
echo "[2/5] 安装 Hapi CLI..."
if ! command -v hapi &>/dev/null; then
  bun install -g @your-org/hapi 2>/dev/null || npm install -g @your-org/hapi
fi

# 3. Setup project
echo "[3/5] 部署 proxy..."
INSTALL_DIR="${INSTALL_DIR:-/opt/codepocket}"
sudo mkdir -p "$INSTALL_DIR"
sudo cp -r "$(dirname "$0")/proxy" "$INSTALL_DIR/"
cd "$INSTALL_DIR/proxy"
bun install --production

# 4. Create systemd services
echo "[4/5] 配置 systemd 服务..."

sudo tee /etc/systemd/system/hapi-hub.service > /dev/null <<EOF
[Unit]
Description=Hapi Hub
After=network.target

[Service]
Type=simple
ExecStart=$(which hapi) hub start --host 127.0.0.1 --port $HUB_PORT
Restart=always
RestartSec=3
Environment=HAPI_LISTEN_HOST=127.0.0.1
Environment=HAPI_LISTEN_PORT=$HUB_PORT
Environment=HAPI_PUBLIC_URL=https://$DOMAIN

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/codepocket-proxy.service > /dev/null <<EOF
[Unit]
Description=CodePocket Proxy
After=network.target hapi-hub.service
Requires=hapi-hub.service

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR/proxy
ExecStart=$(which bun) run src/index.ts
Restart=always
RestartSec=3
Environment=HAPI_HUB_URL=http://127.0.0.1:$HUB_PORT
Environment=PROXY_PORT=$PROXY_PORT

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable hapi-hub codepocket-proxy
sudo systemctl restart hapi-hub

# Wait for hub to start and generate token
sleep 3
sudo systemctl restart codepocket-proxy

# 5. Configure Caddy
echo "[5/5] 配置 Caddy HTTPS..."

EMAIL_ARG=""
if [[ -n "$EMAIL" ]]; then
  EMAIL_ARG="tls $EMAIL"
fi

sudo tee /etc/caddy/Caddyfile > /dev/null <<EOF
$DOMAIN {
    $EMAIL_ARG

    handle /api/* {
        reverse_proxy 127.0.0.1:$PROXY_PORT
    }

    handle /ws {
        reverse_proxy 127.0.0.1:$PROXY_PORT {
            transport http {
                read_timeout 3600s
                write_timeout 3600s
            }
        }
    }

    handle {
        reverse_proxy 127.0.0.1:$PROXY_PORT
    }
}
EOF

sudo systemctl restart caddy

echo ""
echo "=== 部署完成! ==="
echo ""
echo "Hub 地址: https://$DOMAIN"
echo "WebSocket: wss://$DOMAIN/ws"
echo ""
echo "获取 CLI Token:"
echo "  cat ~/.hapi/settings.json | grep cliApiToken"
echo ""
echo "小程序配置:"
echo "  代理地址: https://$DOMAIN"
echo "  CLI Token: (见上方命令输出)"
echo ""
echo "管理命令:"
echo "  systemctl status hapi-hub    # 查看 Hub 状态"
echo "  systemctl status codepocket-proxy  # 查看 Proxy 状态"
echo "  journalctl -u hapi-hub -f   # 查看 Hub 日志"
echo "  journalctl -u codepocket-proxy -f  # 查看 Proxy 日志"
