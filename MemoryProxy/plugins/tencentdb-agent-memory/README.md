# TencentDB Agent Memory for Codex

This plugin sends documented `SessionStart` and `UserPromptSubmit` events to
the loopback Agent Memory sidecar. Codex continues to use its own subscription
transport; the hook only returns delimited `additionalContext`.

The sidecar defaults to `http://127.0.0.1:8097`. Override it with
`TDAI_MEMORY_SIDECAR_URL` only when another loopback address is required. If the
sidecar is unavailable, the executable returns valid empty hook output so the
original Codex prompt continues unchanged.

The executable never reads `transcript_path`. It forwards the documented event
payload, and all writable turn state remains in the sidecar's durable SQLite
journal.
