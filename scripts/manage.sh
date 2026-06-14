#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════
# CodePocket Relay — 用户管理脚本
#
# 用法:
#   bash manage.sh add "张三"          # 添加用户，返回 key
#   bash manage.sh list                # 列出所有用户
#   bash manage.sh revoke <KEY_ID>     # 吊销用户
# ═══════════════════════════════════════════════════════

RELAY_PORT=3010
ENV_FILE="/etc/codepocket-relay.env"

# Load admin key
if [[ ! -f "$ENV_FILE" ]]; then
  echo "[!] 未找到 $ENV_FILE，请先运行 server-setup.sh"
  exit 1
fi

ADMIN_KEY=$(grep ADMIN_KEY "$ENV_FILE" | cut -d= -f2)
BASE_URL="http://127.0.0.1:$RELAY_PORT"

case "${1:-}" in
  add)
    NAME="${2:-unnamed}"
    echo "添加用户: $NAME"
    echo ""
    RESULT=$(curl -s -X POST "$BASE_URL/admin/keys" \
      -H "Authorization: Bearer $ADMIN_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"name\": \"$NAME\"}")
    echo "$RESULT"
    echo ""
    KEY=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('key',''))" 2>/dev/null || echo "")
    if [[ -n "$KEY" ]]; then
      echo "════════════════════════════════════════"
      echo "  把以下信息发给用户:"
      echo ""
      echo "  npx codepocket-connect --relay wss://你的域名/ws --key $KEY"
      echo "════════════════════════════════════════"
    fi
    ;;

  list)
    echo "用户列表:"
    echo ""
    curl -s -H "Authorization: Bearer $ADMIN_KEY" "$BASE_URL/admin/keys" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for k in data.get('keys', []):
    status = '❌ 已吊销' if k['revoked'] else '✓ 活跃'
    print(f\"  {k['id']}  {k['name']:<12}  {k['key']:<12}  {status}\")
" 2>/dev/null || curl -s -H "Authorization: Bearer $ADMIN_KEY" "$BASE_URL/admin/keys"
    ;;

  revoke)
    KEY_ID="${2:-}"
    if [[ -z "$KEY_ID" ]]; then
      echo "用法: bash manage.sh revoke <KEY_ID>"
      echo "先用 bash manage.sh list 查看 KEY_ID"
      exit 1
    fi
    echo "吊销: $KEY_ID"
    curl -s -X DELETE -H "Authorization: Bearer $ADMIN_KEY" "$BASE_URL/admin/keys/$KEY_ID"
    echo ""
    echo "✓ 已吊销"
    ;;

  *)
    echo "CodePocket Relay 用户管理"
    echo ""
    echo "用法:"
    echo "  bash manage.sh add \"用户名\"       添加用户"
    echo "  bash manage.sh list               列出用户"
    echo "  bash manage.sh revoke <KEY_ID>    吊销用户"
    ;;
esac
