#!/bin/sh

set -eu

runtime_pid=""
hook_relay_pid=""

# shellcheck disable=SC2317 # invoked indirectly by the signal traps below
forward_signal() {
  signal_name="$1"
  if [ -n "$runtime_pid" ]; then
    kill "-$signal_name" "$runtime_pid" 2>/dev/null || true
  fi
  if [ -n "$hook_relay_pid" ]; then
    kill "-$signal_name" "$hook_relay_pid" 2>/dev/null || true
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
  hook_relay_pid="$!"
fi

node --import tsx/esm src/index.ts "$@" &
runtime_pid="$!"

set +e
wait "$runtime_pid"
runtime_status="$?"
# 信号 trap 可能在 runtime 退出前中断 wait，此时需要继续等待。
if kill -0 "$runtime_pid" 2>/dev/null; then
  wait "$runtime_pid"
  runtime_status="$?"
fi
set -e

if [ -n "$hook_relay_pid" ]; then
  kill -TERM "$hook_relay_pid" 2>/dev/null || true
  wait "$hook_relay_pid" 2>/dev/null || true
fi

exit "$runtime_status"
