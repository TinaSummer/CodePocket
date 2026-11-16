#!/usr/bin/env bash
# CodePocket npm 包发布脚本
#
# 用法:
#   bash scripts/publish.sh 2.5.5
#
# 流程:
#   1. 从 GitHub Release 下载 3 个平台二进制
#   2. 分发到 4 个平台子包的 bin/
#   3. 同步所有 package.json 的版本号
#   4. 依次 publish 4 个子包
#   5. publish 主包
#   6. 清理本地二进制（避免误 commit）
#
# 设计说明:
#   - 主包 @tina_summer/codepocket 通过 optionalDependencies 引用 4 个平台子包
#   - npm install 时根据 os/cpu 自动只下当前平台对应的子包（行业标准，参考 esbuild/swc/sharp）
#   - 子包先 publish，主包后 publish（主包 optionalDependencies 指向具体版本）

set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 2.5.5"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 0. 预检
if ! command -v npm &>/dev/null; then
  log_error "未找到 npm"
  exit 1
fi
if ! npm whoami &>/dev/null; then
  log_error "未登录 npm，请先 npm login"
  exit 1
fi

# 1. 准备二进制（优先用本地缓存，否则 gh release download）
CACHE="$ROOT/.publish-cache"
log_info "[1/5] 准备二进制 (cache: $CACHE)..."
mkdir -p "$CACHE"
# 优先用本地 vendor/ 里的二进制（开发机自己 build 出来的）
for asset in cpkt-hub cpkt-hub-linux cpkt-hub.exe; do
  if [[ ! -f "$CACHE/$asset" && -f "$ROOT/connector/vendor/$asset" && $(wc -c < "$ROOT/connector/vendor/$asset") -gt 1000000 ]]; then
    log_info "  从 connector/vendor/ 复制 $asset"
    cp "$ROOT/connector/vendor/$asset" "$CACHE/$asset"
  fi
done
# 缺的二进制走 gh release download（curl 在某些网络下连不上 GitHub，gh 走 API 更稳）
missing=()
for asset in cpkt-hub cpkt-hub-linux cpkt-hub.exe; do
  if [[ ! -f "$CACHE/$asset" || $(wc -c < "$CACHE/$asset") -lt 1000000 ]]; then
    missing+=("$asset")
  else
    log_info "  复用缓存 $asset"
  fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  if command -v gh >/dev/null 2>&1; then
    log_info "  gh release download: ${missing[*]}"
    gh release download --repo TinaSummer/CodePocket \
      --dir "$CACHE" --clobber "${missing[@]}"
  else
    # gh 未安装 / GitHub 直连不通 — 从 npm 已发布的上一版平台子包提取二进制
    # (子包只含二进制,与上次发布时完全一致;npm registry 在受限网络下通常可达)
    log_info "  gh 不可用,从 npm 上一版子包提取: ${missing[*]}"
    NPM_PREV=$(npm view @tina_summer/codepocket dist-tags.latest 2>/dev/null || true)
    [[ -z "$NPM_PREV" ]] && { log_error "  无法获取 npm 上一版本号"; exit 1; }
    log_info "  提取来源版本: $NPM_PREV"
    npm_fetch_bin() {  # $1=subpackage $2=output-file
      local tmpdir
      tmpdir=$(mktemp -d)
      (cd "$tmpdir" && npm pack "@tina_summer/$1@$NPM_PREV" --silent >/dev/null 2>&1 \
        && tar xzf *.tgz && cp package/bin/* "$CACHE/$2") \
        || { log_error "  npm pack $1 失败"; exit 1; }
      rm -rf "$tmpdir"
    }
    for asset in "${missing[@]}"; do
      case "$asset" in
        cpkt-hub)        npm_fetch_bin codepocket-darwin-arm64 "$asset" ;;
        cpkt-hub-linux)  npm_fetch_bin codepocket-linux-x64 "$asset" ;;
        cpkt-hub.exe)    npm_fetch_bin codepocket-win32-x64 "$asset" ;;
      esac
    done
  fi
fi
chmod +x "$CACHE/cpkt-hub" "$CACHE/cpkt-hub-linux"

# 2. 分发到子包
log_info "[2/5] 分发二进制到子包..."
mkdir -p packages/darwin-arm64/bin \
         packages/darwin-x64/bin \
         packages/linux-x64/bin \
         packages/win32-x64/bin
# macOS 二进制假设是 universal binary，同时填 arm64 和 x64
# Linux/Windows 只支持 x64（如需 arm64 linux，重新构建并扩展 packages/）
cp "$CACHE/cpkt-hub"       packages/darwin-arm64/bin/codepocket
cp "$CACHE/cpkt-hub"       packages/darwin-x64/bin/codepocket
cp "$CACHE/cpkt-hub-linux" packages/linux-x64/bin/codepocket
cp "$CACHE/cpkt-hub.exe"   packages/win32-x64/bin/codepocket.exe
chmod +x packages/darwin-arm64/bin/codepocket \
         packages/darwin-x64/bin/codepocket \
         packages/linux-x64/bin/codepocket

# 3. 同步版本号（所有 package.json）
log_info "[3/5] 同步版本号到 $VERSION..."
for pkg in connector packages/darwin-arm64 packages/darwin-x64 packages/linux-x64 packages/win32-x64; do
  node -e "
    const fs = require('fs');
    const p = process.argv[1];
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    j.version = process.argv[2];
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
    console.log('  ' + j.name + '@' + j.version);
  " "$pkg/package.json" "$VERSION"
done

# 同步主包 optionalDependencies 的版本（指向子包版本）
node -e "
  const fs = require('fs');
  const p = 'connector/package.json';
  const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (j.optionalDependencies) {
    for (const k of Object.keys(j.optionalDependencies)) {
      j.optionalDependencies[k] = process.argv[1];
    }
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
    console.log('  connector optionalDependencies → $VERSION');
  }
" "$VERSION"

# 4. publish 子包（必须先于主包，主包 optionalDeps 指向具体版本）
log_info "[4/5] 发布平台子包..."
for pkg in darwin-arm64 darwin-x64 linux-x64 win32-x64; do
  pkg_name=$(node -p "require('./packages/$pkg/package.json').name")
  log_info "  publish $pkg_name..."
  (cd "packages/$pkg" && npm publish --access public)
done

# 5. publish 主包（已存在则跳过）
log_info "[5/5] 发布主包..."
if npm view "@tina_summer/codepocket@$VERSION" version &>/dev/null; then
  log_warn "  @tina_summer/codepocket@$VERSION 已发布，跳过"
else
  (cd connector && npm publish --access public)
fi

# 清理（二进制不进 git）
rm -f packages/*/bin/codepocket packages/*/bin/codepocket.exe
log_info "✓ 完成: @tina_summer/codepocket@$VERSION (含 4 个平台子包)"
log_info "用户 npm i -g @tina_summer/codepocket 时会自动只下载当前平台子包"
