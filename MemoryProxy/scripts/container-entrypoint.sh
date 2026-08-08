#!/bin/sh

set -eu

app_pid=""
relay_pid=""

# shellcheck disable=SC2317 # invoked indirectly by the signal traps below
forward_signal() {
  signal="$1"
  if [ -n "$app_pid" ]; then
    kill "-$signal" "$app_pid" 2>/dev/null || true
  fi
  if [ -n "$relay_pid" ]; then
    kill "-$signal" "$relay_pid" 2>/dev/null || true
  fi
}

trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT

if [ "${PROXY_HOOK_BRIDGE_ENABLED:-0}" = "1" ]; then
  hook_port="${PROXY_HOOK_PORT:-8097}"
  bridge_port="${PROXY_HOOK_BRIDGE_PORT:-18097}"
  socat \
    "TCP-LISTEN:${bridge_port},bind=0.0.0.0,reuseaddr,fork" \
    "TCP:127.0.0.1:${hook_port}" &
  relay_pid="$!"
fi

node --import tsx/esm src/index.ts "$@" &
app_pid="$!"

set +e
wait "$app_pid"
app_status="$?"
if kill -0 "$app_pid" 2>/dev/null; then
  wait "$app_pid"
  app_status="$?"
fi
set -e

if [ -n "$relay_pid" ]; then
  kill -TERM "$relay_pid" 2>/dev/null || true
  wait "$relay_pid" 2>/dev/null || true
fi

exit "$app_status"
