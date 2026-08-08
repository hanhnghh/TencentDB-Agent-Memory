#!/usr/bin/env bash
# 一键拉起 memory → memory-hub → proxy 三件套。
#
# 顺序：先起 memory（内核），等 healthy；再起 memory-hub（面板+知识），等 healthy；
# 最后起 proxy。任意一步失败会中止并打印容器日志。
#
# 用法：
#   ./start-all.sh            # 本地已有镜像就直接用
#   PULL=1 ./start-all.sh     # 先 docker pull 三个镜像，升级到最新 latest
#
# 前置：cp .env.example .env，选择 mode 并填写 active dependencies。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

load_env
load_proxy_mode

# 一次性校验 active mode 的必填参数，避免拉起 memory 之后才发现依赖缺失。
require_vars \
  MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE \
  MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT \
  MEMORY_CORE_VOLUME PANEL_VOLUME \
  MEMORY_LLM_BASE_URL MEMORY_LLM_API_KEY MEMORY_LLM_MODEL \
  KNOWLEDGE_PUBLIC_BASE_URL
require_proxy_deployment_vars

info "═══ Step 1/3: memory ═══════════════════════════════════════"
"$SCRIPT_DIR/start-memory-core.sh"

info "═══ Step 2/3: memory-hub ═══════════════════════════════════"
"$SCRIPT_DIR/start-memory-hub.sh"

info "═══ Step 3/3: MemoryProxy ($PROXY_RUNTIME_MODE) ═════════════"
# 默认打开完整流水线（auth + sessionInit + tdai 注入）。
# 用户可用 PROXY_FULL_STACK=0 关闭；也可在 .env 分别覆盖三个开关。
PROXY_FULL_STACK="${PROXY_FULL_STACK:-1}" "$SCRIPT_DIR/start-proxy.sh"

ok "═══ 全部服务已就绪 ═════════════════════════════════════════"
print_endpoints

# 打印与 active mode 对应的下一步。
ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$SCRIPT_DIR/.admin-key}"
if proxy_transport_enabled && [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  UPSTREAM_MODEL="${PROXY_UPSTREAM_MODEL:-<your-model>}"
  echo ""
  echo "  ┌─ 通过 proxy 用 Claude Code ─────────────────────────────────────┐"
  echo "  │  export ANTHROPIC_BASE_URL=http://127.0.0.1:${PROXY_PORT}/claude-code/default"
  echo "  │  export ANTHROPIC_AUTH_TOKEN='${ADMIN_KEY}'"
  echo "  │  claude --model ${UPSTREAM_MODEL}"
  echo "  │"
  echo "  │  admin user_key 保存在: $ADMIN_KEY_FILE"
  echo "  └────────────────────────────────────────────────────────────────┘"
fi
if hook_transport_enabled; then
  echo ""
  echo "  Codex hooks: http://127.0.0.1:${PROXY_HOOK_PORT}"
  echo "  Bind/doctor 需要 Memory Hub user key；容器启动不需要 proxy upstream key。"
  echo "  详见 ../../INSTALL.md 的 Codex hooks 部署章节。"
fi
echo ""
echo "  查看日志：  docker logs -f tdai-memory-core | tdai-memory-hub | tdai-proxy"
echo "  停止服务：  ./stop-all.sh"
echo ""
