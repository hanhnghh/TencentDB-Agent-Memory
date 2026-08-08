# TencentDB Agent Memory for Codex

Install this plugin from the package marketplace with
`tdai-codex-memory install` (or `npm run codex -- install` from the source
package). Installation prints the SHA-256 of these hook definitions but does
not claim they are trusted. Install starts a managed hooks-only sidecar using
`MEMORY_CORE_SERVICE_TOKEN` from the environment. Review the hooks in Codex
with `/hooks`, then run `tdai-codex-memory trust --hooks-sha <reviewed-sha256>`
and verify all lifecycle, live binding, MemoryCore, and outbox checks with
`tdai-codex-memory doctor`.

Writable SQLite/outbox state lives in the protected user-level plugin data
directory, never in this plugin root. Uninstall stops the managed sidecar and
retains that durable data by
default and prints its location; `uninstall --purge-data` deletes it explicitly.

This plugin sends documented `SessionStart`, `UserPromptSubmit`, `PostToolUse`,
`Stop`, and `SessionEnd` events to the loopback Agent Memory sidecar. Codex
continues to use its own subscription transport; lifecycle hooks only prepare
context or journal completed-round evidence.

The sidecar defaults to `http://127.0.0.1:8097`. Override it with
`TDAI_MEMORY_SIDECAR_URL` only when another loopback address is required. If the
sidecar is unavailable, context reads return valid empty hook output so the
original Codex prompt continues unchanged. Durable `UserPromptSubmit`,
`PostToolUse`, and `Stop` writes instead exit unsuccessfully; they are never
acknowledged before local persistence or completed-round enqueue succeeds.

The executable never reads `transcript_path`. It forwards the documented event
payload, and all writable turn state remains in the sidecar's durable SQLite
journal. Observable shell/exec, `apply_patch`, and MCP calls are correlated by
Codex session, turn, and tool-use IDs. `Stop` emits one L0 user/assistant pair
and one tool-aware skill round through the durable outbox. Duplicate events and
restart replay are idempotent. `SessionEnd` is advisory and is not a commit
point.

After `SessionStart`, the sidecar exposes capability-gated memory, skill, and
Wiki/CodeGraph bridges only to that initialized Codex session. It binds
Team/Agent/Task identity on the server and accepts only allowlisted operations.
Run `npm run codex -- mem-help` from `MemoryProxy` for explicit hooks-mode
`sync`, `refresh`, `force-archive`, and `create-skill` commands. `mem:*`
response interception is available only when using the public proxy transport.

Some hosted or specialized tools do not emit `PostToolUse`; those calls cannot
be captured. The plugin does not infer them from the unstable transcript
format and does not claim tool-event parity for those paths.
