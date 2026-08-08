#!/usr/bin/env bash
# 单独拉起 MemoryProxy（proxy、hooks 或 both）。
#
# proxy 的转发上游走 PROXY_UPSTREAM_URL（与 memory 组的 MEMORY_LLM_* 独立）。
# proxy 会调 memory:8420 做鉴权 / skill / tdai memory 注入；调 memory-hub:8125
# 做 sessionInit control plane。可以单跑 proxy 但相关能力会降级 / 关闭。
#
# 用法：
#   ./start-proxy.sh
#
# `hooks` 不需要任何 PROXY_UPSTREAM_* 参数；proxy/both 根据
# PROXY_UPSTREAM_AUTH_MODE 选择 server-key 或 client-key passthrough。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

load_env
load_proxy_mode
require_proxy_deployment_vars

# 与 memory-core 保持一致；显式空值表示本地部署关闭 Gateway Bearer gate。
MEMORY_CORE_GATEWAY_API_KEY="${MEMORY_CORE_GATEWAY_API_KEY-}"

CONTAINER=tdai-proxy
NETWORK=tdai-memory-stack
CONTAINER_PROXY_PORT=8096
CONTAINER_HOOK_PORT=8097
CONTAINER_HOOK_BRIDGE_PORT=18097
CONTAINER_DATA_DIR=/data/tdai-memory-proxy
CONTAINER_DB_PATH="$CONTAINER_DATA_DIR/proxy.db"

if ! $DOCKER network inspect "$NETWORK" >/dev/null 2>&1; then
  info "创建 docker 网络 $NETWORK"
  $DOCKER network create "$NETWORK" >/dev/null
fi

# 依赖检查（不阻塞，仅提醒）
if ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "tdai-memory-core"; then
  warn "memory-core 容器未运行，proxy 的 auth / tdai memory / skill 注入将全部降级。"
fi
if ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "tdai-memory-hub"; then
  warn "memory-hub 容器未运行，proxy 的 sessionInit control plane 不可达。"
fi

pull_image "$PROXY_IMAGE"
rm_container_if_exists "$CONTAINER"

# proxy 只从 YAML 读上游 URL / API key（不认 PROXY_UPSTREAM_URL 环境变量），
# 所以我们从 .env 生成一个最小 config.yaml 挂到容器 /data/config.yaml。
# 容器 CMD 已经是 [--config /data/config.yaml]。
CONFIG_DIR="${PROXY_CONFIG_DIR:-$SCRIPT_DIR/.proxy-config}"
mkdir -p "$CONFIG_DIR"
CONFIG_FILE="$CONFIG_DIR/config.yaml"

# ── 三大能力开关（默认最小可用；打开时自动串联依赖）──
# PROXY_ENABLE_AUTH        : 客户端凭 x-tdai-user-key 走内核 auth/verify → user_id
# PROXY_ENABLE_SESSION_INIT: 首轮弹表单选 team/agent/task；依赖 auth+tdai
# PROXY_ENABLE_TDAI        : L2/L3 记忆注入 + L1 召回；依赖 memory-core
#
# 便捷开关 PROXY_FULL_STACK=1 一键把三个都开。
if [[ "${PROXY_FULL_STACK:-0}" == "1" ]]; then
  PROXY_ENABLE_AUTH=1
  PROXY_ENABLE_TDAI=1
  PROXY_ENABLE_SESSION_INIT=1
fi
PROXY_ENABLE_AUTH="${PROXY_ENABLE_AUTH:-0}"
PROXY_ENABLE_TDAI="${PROXY_ENABLE_TDAI:-0}"
PROXY_ENABLE_SESSION_INIT="${PROXY_ENABLE_SESSION_INIT:-0}"

# sessionInit 依赖 auth 拿 user_id；开 sessionInit 时自动补 auth
if [[ "$PROXY_ENABLE_SESSION_INIT" == "1" && "$PROXY_ENABLE_AUTH" != "1" ]]; then
  warn "PROXY_ENABLE_SESSION_INIT=1 需要 auth；自动打开 PROXY_ENABLE_AUTH"
  PROXY_ENABLE_AUTH=1
fi

bool() { [[ "$1" == "1" ]] && echo "true" || echo "false"; }

UPSTREAM_URL=""
UPSTREAM_API_KEY=""
if proxy_transport_enabled; then
  UPSTREAM_URL="$PROXY_UPSTREAM_URL"
  if [[ "$PROXY_UPSTREAM_AUTH_MODE" == "server-key" ]]; then
    UPSTREAM_API_KEY="$PROXY_UPSTREAM_API_KEY"
  fi
fi

info "生成 proxy config → $CONFIG_FILE  (mode=$PROXY_RUNTIME_MODE upstream-auth=$PROXY_UPSTREAM_AUTH_MODE auth=$(bool "$PROXY_ENABLE_AUTH") session-init=$(bool "$PROXY_ENABLE_SESSION_INIT") tdai=$(bool "$PROXY_ENABLE_TDAI"))"
cat > "$CONFIG_FILE" <<YAML
# 由 start-proxy.sh 自动生成 —— 每次启动覆盖，请不要手动改。
runtime:
  mode: ${PROXY_RUNTIME_MODE}
  hooks:
    host: 127.0.0.1
    port: ${CONTAINER_HOOK_PORT}

server:
  host: 0.0.0.0
  port: ${CONTAINER_PROXY_PORT}
  forwardTimeoutMs: 600000

upstream:
  url: "${UPSTREAM_URL}"
  apiKey: "${UPSTREAM_API_KEY}"

log:
  file: ""
  level: info
  backend: console

# tdai 内核对接（用于 injection / skill / auth 拉取）
tdai:
  enabled: $(bool "$PROXY_ENABLE_TDAI")
  endpoint: "http://memory-core:8420"
  apiKey: "${MEMORY_CORE_GATEWAY_API_KEY}"
  serviceId: default
  memory:
    enabled: true
    inject: true
    writeL0: true
    recallL1: true
    injectL2L3: true

skill:
  endpoint: "http://memory-core:8420"
  serviceToken: "${MEMORY_CORE_GATEWAY_API_KEY}"

auth:
  enabled: $(bool "$PROXY_ENABLE_AUTH")
  url: "http://memory-core:8420"
  timeoutMs: 5000

sessionInit:
  enabled: $(bool "$PROXY_ENABLE_SESSION_INIT")
  maxRetries: 3
  injectAgentContext: true
  injectTaskContext: true
  headerAutoSelect:
    enabled: true
    teamHeader: "x-team-id"
    agentHeader: "x-agent-id"
    taskHeader: "x-task-id"
    onMismatch: "form"

costGuard:
  enabled: false

# 打开 skill + knowledge + tdai-memory 三个注入器；
# knowledge 依赖 memory-hub 起来，否则 hook 内部会降级为空块。
injection:
  enabled: true
  injectors:
    - skill
    - knowledge
    - tdai-memory

redis:
  enabled: false

storage:
  enabled: true
  backend: sqlite
  sqlite:
    dbPath: ${CONTAINER_DB_PATH}
YAML

HEALTH_PORT=$CONTAINER_PROXY_PORT
HOOK_BRIDGE_ENABLED=0
PORT_ARGS=()
if proxy_transport_enabled; then
  PORT_ARGS+=( -p "${PROXY_PORT}:${CONTAINER_PROXY_PORT}" )
fi
if hook_transport_enabled; then
  PORT_ARGS+=( -p "127.0.0.1:${PROXY_HOOK_PORT}:${CONTAINER_HOOK_BRIDGE_PORT}" )
  HOOK_BRIDGE_ENABLED=1
  if [[ "$PROXY_RUNTIME_MODE" == "hooks" ]]; then
    HEALTH_PORT=$CONTAINER_HOOK_PORT
  fi
fi

info "启动 MemoryProxy (image=$PROXY_IMAGE, mode=$PROXY_RUNTIME_MODE)"
$DOCKER run -d --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias proxy \
  --add-host=host.docker.internal:host-gateway \
  "${PORT_ARGS[@]}" \
  -e "PROXY_HEALTH_PORT=${HEALTH_PORT}" \
  -e "PROXY_HOOK_BRIDGE_ENABLED=${HOOK_BRIDGE_ENABLED}" \
  -e "PROXY_HOOK_PORT=${CONTAINER_HOOK_PORT}" \
  -e "PROXY_HOOK_BRIDGE_PORT=${CONTAINER_HOOK_BRIDGE_PORT}" \
  -e "PROXY_DB_PATH=${CONTAINER_DB_PATH}" \
  -e "PROXY_OUTBOX_PATH=${CONTAINER_DB_PATH}" \
  -v "${PROXY_VOLUME}:${CONTAINER_DATA_DIR}" \
  -v "$CONFIG_FILE:/data/config.yaml:ro" \
  "$PROXY_IMAGE" >/dev/null

wait_healthy "$CONTAINER" 90
if proxy_transport_enabled; then
  ok "proxy listener 已启动 → http://localhost:${PROXY_PORT}/"
fi
if hook_transport_enabled; then
  ok "hook listener 已启动 → http://127.0.0.1:${PROXY_HOOK_PORT}/"
fi
