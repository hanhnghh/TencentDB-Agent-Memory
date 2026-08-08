#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
proxy_dir="$repo_root/MemoryProxy"
tsc="$proxy_dir/node_modules/.bin/tsc"

if [[ ! -x "$tsc" ]]; then
  echo "MemoryProxy dependencies are missing; install them once before running the type gate." >&2
  exit 2
fi

diagnostics="$(mktemp)"
unexpected="$(mktemp)"
trap 'rm -f "$diagnostics" "$unexpected"' EXIT

if (cd "$proxy_dir" && "$tsc" --noEmit --pretty false) >"$diagnostics" 2>&1; then
  echo "MemoryProxy TypeScript gate passed with no diagnostics."
  exit 0
fi

while IFS= read -r diagnostic; do
  normalized="$(sed -E 's/\([0-9]+,[0-9]+\)//' <<<"$diagnostic")"
  case "$normalized" in
    "src/config.ts: error TS2339: Property 'memCommand' does not exist on type 'RawYamlConfig'.") ;;
    "src/session/claude-code/init.ts: error TS2353: Object literal may only specify known properties, and 'isDefault' does not exist in type '{ task_id: string; task_name: string; }'.") ;;
    "src/session/codebuddy/init.ts: error TS2353: Object literal may only specify known properties, and 'isDefault' does not exist in type '{ task_id: string; task_name: string; }'.") ;;
    "src/storage/factory.ts: error TS2307: Cannot find module '@context-proxy/cost-guard' or its corresponding type declarations.") ;;
    *) printf '%s\n' "$diagnostic" >>"$unexpected" ;;
  esac
done <"$diagnostics"

if [[ -s "$unexpected" ]]; then
  echo "MemoryProxy TypeScript gate found diagnostics outside the documented baseline:" >&2
  cat "$unexpected" >&2
  exit 1
fi

echo "MemoryProxy TypeScript gate passed: only documented baseline diagnostics remain."
