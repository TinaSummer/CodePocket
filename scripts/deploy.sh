#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════
# CodePocket Relay 部署脚本 (宝塔面板版)
#
# 用法:
#   bash scripts/deploy.sh            # 完整部署
#   bash scripts/deploy.sh update     # 仅更新代码并重启
#   bash scripts/deploy.sh start      # 启动服务
#   bash scripts/deploy.sh stop       # 停止服务
#   bash scripts/deploy.sh restart    # 重启服务
#   bash scripts/deploy.sh status     # 查看状态
#   bash scripts/deploy.sh logs       # 查看日志
# ═══════════════════════════════════════════════════════

DOMAIN="${DOMAIN:-your-domain.com}"
RELAY_PORT=3010
INSTALL_DIR="/opt/codepocket-relay"
REPO_DIR="/opt/codemind"
REPO_URL="https://github.com/TinaSummer/CodePocket.git"
GIT_BRANCH="main"
SERVICE_NAME="codepocket-relay"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ========== 服务管理 ==========

stop_service() {
  if pm2 pid "$SERVICE_NAME" &>/dev/null; then
    log_info "停止服务..."
    pm2 stop "$SERVICE_NAME" || true
    log_info "服务已停止"
  else
    log_info "服务未在运行"
  fi
}

start_service() {
  if [[ ! -f "$INSTALL_DIR/src/index.js" ]]; then
    log_error "未找到 $INSTALL_DIR/src/index.js，请先执行完整部署"
    exit 1
  fi

  # 如果 PM2 里已有该服务，直接 restart
  if pm2 pid "$SERVICE_NAME" &>/dev/null; then
    pm2 restart "$SERVICE_NAME"
  else
    cd "$INSTALL_DIR"
    # 从环境文件读取变量
    if [[ -f /etc/codepocket-relay.env ]]; then
      export $(grep -v '^#' /etc/codepocket-relay.env | xargs)
    fi
    pm2 start src/index.js \
      --name "$SERVICE_NAME" \
      --node-args="--max-old-space-size=256"
    pm2 save
  fi

  sleep 2
  if pm2 pid "$SERVICE_NAME" &>/dev/null; then
    log_info "服务启动成功 (PID: $(pm2 pid "$SERVICE_NAME"))"
  else
    log_error "服务启动失败"
    pm2 logs "$SERVICE_NAME" --lines 10 --nostream
    exit 1
  fi
}

show_status() {
  pm2 status "$SERVICE_NAME" 2>/dev/null || pm2 status
}

show_logs() {
  pm2 logs "$SERVICE_NAME"
}

# ========== 代码 ==========

pull_code() {
  if [[ -d "$REPO_DIR/.git" ]]; then
    cd "$REPO_DIR"
    log_info "拉取最新代码..."
    git fetch origin
    git reset --hard "origin/$GIT_BRANCH"
  else
    rm -rf "$REPO_DIR"
    log_info "克隆仓库: $REPO_URL"
    git clone -b "$GIT_BRANCH" "$REPO_URL" "$REPO_DIR"
  fi
}

copy_relay() {
  if [[ -f "$REPO_DIR/relay/src/index.node.js" ]]; then
    cp "$REPO_DIR/relay/src/index.node.js" "$INSTALL_DIR/src/index.js"
    # 同步 package.json 确保新依赖能被 npm install 安装
    if [[ -f "$REPO_DIR/relay/package.json" ]]; then
      cp "$REPO_DIR/relay/package.json" "$INSTALL_DIR/package.json"
    fi
    log_info "relay 代码已更新"
  else
    log_error "未找到 relay/src/index.node.js"
    exit 1
  fi
}

install_deps() {
  cd "$INSTALL_DIR"
  npm install --production 2>/dev/null
  log_info "依赖已更新"
}

# ========== 首次部署 ==========

do_deploy() {
  local ADMIN_KEY
  ADMIN_KEY=$(openssl rand -hex 32)

  echo ""
  echo "╔══════════════════════════════════════╗"
  echo "║  CodePocket Relay 部署 (宝塔版)      ║"
  echo "╚══════════════════════════════════════╝"
  echo ""
  echo "  域名:   $DOMAIN"
  echo "  端口:   $RELAY_PORT (仅 127.0.0.1)"
  echo "  目录:   $INSTALL_DIR"
  echo "  密钥:   ${ADMIN_KEY:0:8}..."
  echo ""

  # 1. Node.js
  log_info "[1/5] 检查 Node.js..."
  if ! command -v node &>/dev/null; then
    log_info "安装 Node.js 20..."
    if command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif command -v yum &>/dev/null; then
      curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
      sudo yum install -y nodejs
    else
      log_error "不支持的系统，请手动安装 Node.js 20+"
      exit 1
    fi
  fi
  log_info "Node: $(node -v)"

  # 2. 代码
  log_info "[2/5] 部署代码..."
  sudo mkdir -p "$INSTALL_DIR/src"

  pull_code
  copy_relay

  # package.json
  sudo tee "$INSTALL_DIR/package.json" > /dev/null <<'PKGEOF'
{
  "name": "codepocket-relay",
  "version": "1.0.0",
  "private": true,
  "scripts": { "start": "node src/index.js" },
  "dependencies": {
    "hono": "^4.7.0",
    "@hono/node-ws": "^1.3.0",
    "@hono/node-server": "^1.13.0",
    "cos-nodejs-sdk-v5": "^2.15.4"
  }
}
PKGEOF

  cd "$INSTALL_DIR"
  sudo npm install --production --omit=dev
  log_info "依赖安装完成"

  # 3. 密钥
  log_info "[3/5] 配置密钥..."
  sudo mkdir -p "$INSTALL_DIR/data"
  sudo tee /etc/codepocket-relay.env > /dev/null <<EOF
RELAY_PORT=$RELAY_PORT
RELAY_KEYS=$ADMIN_KEY
DATA_DIR=$INSTALL_DIR/data
NODE_ENV=production
EOF
  sudo chmod 600 /etc/codepocket-relay.env
  log_info "密钥已保存到 /etc/codepocket-relay.env"

  # 4. PM2
  log_info "[4/5] 启动服务..."
  if ! command -v pm2 &>/dev/null; then
    log_info "安装 PM2..."
    sudo npm install -g pm2
  fi

  pm2 delete "$SERVICE_NAME" 2>/dev/null || true
  start_service

  # 5. Nginx 提示
  log_info "[5/5] Nginx 反向代理配置..."

  sudo tee "$INSTALL_DIR/nginx-proxy.conf" > /dev/null <<NGINXEOF
# CodePocket Relay — Nginx 反向代理配置
# 宝塔面板: 站点 → 反向代理 → 自定义配置 → 粘贴此内容

location /ws {
    proxy_pass http://127.0.0.1:$RELAY_PORT;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location / {
    proxy_pass http://127.0.0.1:$RELAY_PORT;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
}
NGINXEOF

  echo ""
  echo "════════════════════════════════════════"
  echo "  部署完成!"
  echo "════════════════════════════════════════"
  echo ""
  echo "  Relay:     https://$DOMAIN"
  echo "  WebSocket: wss://$DOMAIN/ws"
  echo ""
  echo "  ⚠️  ADMIN_KEY (请保存):"
  echo "  $ADMIN_KEY"
  echo ""
  echo "  管理用户密钥:"
  echo "    curl -X POST http://127.0.0.1:$RELAY_PORT/admin/keys \\"
  echo "      -H \"Authorization: Bearer $ADMIN_KEY\" \\"
  echo "      -H \"Content-Type: application/json\" \\"
  echo "      -d '{\"name\": \"用户名\"}'"
  echo ""
  echo "  Nginx 配置: cat $INSTALL_DIR/nginx-proxy.conf"
  echo ""

  # 验证
  sleep 1
  if curl -s "http://127.0.0.1:$RELAY_PORT/" 2>/dev/null | grep -q "codepocket-relay"; then
    log_info "Relay 本地响应正常"
  else
    log_warn "Relay 未响应，检查: pm2 logs $SERVICE_NAME"
  fi
}

# ========== 更新 ==========

do_update() {
  if [[ ! -d "$INSTALL_DIR" ]]; then
    log_error "未找到安装目录 $INSTALL_DIR，请先执行完整部署"
    exit 1
  fi

  echo ""
  echo "════════════════════════════════════════"
  echo "  CodePocket Relay - 更新模式"
  echo "════════════════════════════════════════"
  echo ""

  # 备份
  cp "$INSTALL_DIR/src/index.js" "$INSTALL_DIR/src/index.js.bak.$(date +%Y%m%d%H%M%S)"
  log_info "已备份旧代码"

  # 拉取代码（失败不中断，继续用现有代码重启）
  if pull_code; then
    log_info "代码更新成功"
  else
    log_warn "代码拉取失败，使用现有代码继续重启"
  fi

  # 复制 relay 代码
  copy_relay

  # 安装依赖（失败不中断）
  if ! install_deps 2>/dev/null; then
    log_warn "依赖安装失败，使用现有依赖继续"
  fi

  # 重启（带环境变量）
  if [[ -f /etc/codepocket-relay.env ]]; then
    export $(grep -v '^#' /etc/codepocket-relay.env | xargs)
  fi
  if pm2 pid "$SERVICE_NAME" &>/dev/null; then
    pm2 restart "$SERVICE_NAME" --update-env
  else
    cd "$INSTALL_DIR"
    pm2 start src/index.js --name "$SERVICE_NAME" --node-args="--max-old-space-size=256"
    pm2 save
  fi

  # 验证
  if pm2 pid "$SERVICE_NAME" &>/dev/null; then
    log_info "服务已用最新代码重启成功！"
    log_info "当前版本: $(cd "$REPO_DIR" && git log --oneline -1 2>/dev/null || echo 'unknown')"
  fi

  echo ""
}

# ========== 主逻辑 ==========

ACTION="${1:-deploy}"

case "$ACTION" in
  stop)
    stop_service
    ;;
  start)
    start_service
    show_status
    ;;
  restart)
    stop_service
    start_service
    show_status
    ;;
  status)
    show_status
    ;;
  logs)
    show_logs
    ;;
  update)
    do_update
    ;;
  deploy|full)
    do_deploy
    ;;
  *)
    echo "用法: $0 {deploy|update|start|stop|restart|status|logs}"
    exit 1
    ;;
esac
