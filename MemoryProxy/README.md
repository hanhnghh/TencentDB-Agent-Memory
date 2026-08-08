# MemoryProxy

MemoryProxy is a **transparent LLM request proxy**: instead of having a coding agent (Claude Code / CodeBuddy / ...) talk to the LLM directly, requests are routed through the proxy first. Around each forward it automatically runs session initialization, memory injection, conversation write-back and more, so an agent can tap into the team memory, Skills and Knowledge provided by [MemoryCore](../MemoryCore/README.md) **without changing a single line of code**.

It is "transparent" to both the client and the upstream model — it changes no protocol and forwards OpenAI `/v1/chat/completions` and Anthropic `/v1/messages` verbatim. It just does a few extra things on the way in and out: **session initialization, context injection, conversation write-back, authentication and usage reporting**.

> In one line: MemoryProxy handles "access & forwarding"; MemoryCore handles "storage & processing" of memory. The proxy itself persists no memory data — all Memory / Skill / Knowledge reads and writes go through the MemoryCore Gateway (default `:8420`). For the overall product positioning, see the repo root [README.md](../README.md).

## Where it fits

```text
Coding agent (Claude Code / CodeBuddy / ...)
        │  OpenAI / Anthropic protocol (unchanged)
        ▼
   MemoryProxy :8096        ← this project (LLM request proxy)
        │  session init / injection / write-back / auth / reporting
        ├─────────────► Upstream LLM (TokenHub / OpenAI-compatible)
        │
        └─ HTTP API ─► MemoryCore Gateway :8420
                        ├─ Memory  L0 / L1 / L2 / L3
                        ├─ Skill   search / archive / extract
                        └─ Meta    Team / Agent / Task / Knowledge
```

## Core capabilities

- **Session initialization**: intercepts the first request and guides the user through an interactive form to pick team → agent → task, then injects the agent/task context into the system prompt. Supports auto pre-selection from request headers (`x-team-id` / `x-agent-id` / `x-task-id`).
- **Context injection**: injects Skills, Knowledge and Memory L2/L3 into the system prompt on demand; L0/L1 are exposed as read-only tools for the model to query proactively, avoiding upstream KV-cache invalidation.
- **Conversation write-back (extraction)**: at the end of each human turn, sends the conversation slice to MemoryCore `/v3/skill/conversation/add` (Skill archival) and writes L0 short-term memory for background extraction on the core side.
- **Auth & identity**: calls MemoryCore `POST /v3/meta/auth/verify` to validate `x-tdai-user-key` and resolve `user_id` as the end-to-end user identity; `spaceId` (memory instance id) is auto-extracted from the `/proxy/<spaceId>/...` path.
- **System-user passthrough**: internal service accounts (e.g. memory / wiki internal calls) short-circuit session init and injection on match, doing pure passthrough + billing only.
- **Skill Bridge / Memory Bridge**: reverse-proxies MemoryCore's skill / memory HTTP tools, injecting `serviceToken` on forward so credentials never appear in an LLM-visible prompt.
- **Unified storage abstraction (ProxyStorage)**: session init state, injection cache and Skill state (`inj:*` / `sk:*` / `vpin:*`) support five backends — Redis, COS (kernel-sts), SQLite, FS, Memory. COS is preferred for multi-node deployments.
- **Input TPM / QPM rate limiting**: 60-second sliding-window limiting on Redis, keyed by `spaceId × final model`, adjustable at runtime via `/v3/admin/rate-limits`.
- **Observability & usage reporting**: three independent channels — Opik trace, Langfuse (one trace = one turn), ClickHouse (per-turn token detail). Any one failing does not affect the business path.
- **Credit billing report**: after each upstream response completes, computes CreditDelta from the pricing table and reports it to the billing service; only requests whose path carries `/proxy/<spaceId>/` are counted.
- **Multi-node deployment**: scales horizontally with an external gateway plus the COS backend; the `/skill-bridge` and `/memory-bridge` prefixes are passed through verbatim from the gateway to proxy instances.

## Request pipeline

A main-model call carrying `spaceId` roughly goes through these stages:

```text
POST /proxy/<spaceId>/v1/chat/completions | /v1/messages
   │
   ├─ 1. auth ─────── validate x-tdai-user-key, resolve user_id
   ├─ 2. systemUser ─ short-circuit passthrough on internal-account match
   ├─ 3. sessionInit ─ first turn shows a form: team → agent → task
   ├─ 4. injection ── inject skill / knowledge / memory into system prompt
   ├─ 5. rateLimit ── spaceId × final-model TPM/QPM limiting
   ├─ 6. forward ──── forward to the upstream LLM
   ├─ 7. extract ──── async write-back of conversation + L0 after the turn
   └─ 8. report ───── ClickHouse / Langfuse / Opik / Credit reporting
```

## Memory layers & injection strategy

MemoryProxy mirrors MemoryCore's four-layer memory structure, plugging into the prompt via two modes — "inject" and "toolize":

| Layer | Role | How it plugs in |
| --- | --- | --- |
| L0 | Short-term conversation memory | proxy writes it back to MemoryCore each turn |
| L1 | Session-level key memory | recalled on demand by the model via the `<tdai_memory_tools>` tools |
| L2 | Agent Profile | injected directly into the system prompt |
| L3 | Team / Global memory | injected directly into the system prompt |

Skills and Knowledge follow the same idea:

- `<cloud_skills>` — summaries of relevant Skills retrieved from MemoryCore RAG
- `<skill_tools>` — a block telling the model how to call Skills via curl (read/write permission controlled by `skillRuntime.allowLlmWrite`)
- `<knowledge_tools>` — two-step self-discovery tools for team knowledge resources (Wiki / CodeGraph)
- `<session_context>` — agent/task info appended every turn after session init completes

## Requirements

- Node.js `v22.x` (checked strictly at startup; `>= 22.16.0` recommended)
- npm or pnpm
- A running **MemoryCore Gateway** (default `:8420`) providing Auth / Skill / Meta / Memory APIs
- Redis (default backing store for session/injection/Skill state; switchable once `storage.enabled=true`)
- An OpenAI-compatible upstream LLM API (TokenHub or others)

## Quick start

### Install, trust, and diagnose the Codex integration

From `MemoryProxy`, install dependencies and register the packaged local
marketplace/plugin:

```bash
npm install
export MEMORY_CORE_ENDPOINT=http://127.0.0.1:8420
export MEMORY_CORE_SERVICE_TOKEN=service-token-from-deployment-config
npm run codex -- install --config config.yaml
```

The install command uses argument arrays, so repository and package paths may
contain spaces. It creates protected writable sidecar state under
`$XDG_CONFIG_HOME/tencentdb-agent-memory/codex/plugin-data/data` (or
`~/.config/tencentdb-agent-memory/codex/plugin-data/data`) and never writes runtime state
into the immutable plugin package. Installation reports the exact SHA-256 of
`hooks.json`, deliberately reports the hooks as **NOT TRUSTED**, and starts a
managed hooks-only sidecar. The service token is inherited from the environment
and is never copied into project files, installation state, process arguments,
or diagnostic output.

Open Codex, use `/hooks` to review the installed definitions, then record the
exact digest printed by install:

```bash
npm run codex -- trust --hooks-sha <reviewed-sha256>
```

Install and upgrade manage the sidecar lifecycle. For foreground debugging,
stop the managed installation first and run this command manually; it forces
`hooks` mode and places both the proxy database and durable outbox in the
protected data directory:

```bash
npm run codex -- sidecar --config config.yaml
```

After binding the project as shown below, run the complete diagnostic:

```bash
npm run codex -- doctor
```

Doctor reports `plugin_installed`, `plugin_enabled`, `hooks_trusted`,
`sidecar_reachable`, `project_binding`, `binding_valid`, `memory_core_reachable`, and
`outbox_healthy` independently. It prints no stored key or service token. A
package upgrade is explicit; if `hooks.json` changed, its digest no longer
matches and trust returns to failed until the new definitions are reviewed:

```bash
npm run codex -- upgrade
```

Uninstall first drains/stops the managed sidecar, then removes the Codex plugin
and stops new lifecycle hook delivery. Durable sidecar data is retained and its path is printed. Use
`--purge-data` only when that database should be deleted; project binding and
protected credentials remain until `unbind` (optionally
`unbind --forget-credential`) is run.

```bash
npm run codex -- uninstall
# or, to permanently delete the local durable database:
npm run codex -- uninstall --purge-data
```

### Codex project binding

Codex uses a project-local, non-secret Team/Agent/Task binding. The bind command
verifies the user key and confirms that all three IDs are visible through the
MemoryCore metadata APIs before writing either file. Task is required by the
current runtime contract.

```bash
export MEMORY_CORE_ENDPOINT=http://127.0.0.1:8420
export MEMORY_CORE_SERVICE_TOKEN=service-token-from-deployment-config
export MEMORY_HUB_USER_KEY=your-memory-hub-user-key

npm run codex -- bind \
  --service-id mem-example001 \
  --team-id team-id \
  --agent-id agent-id \
  --task-id task-id

npm run codex -- binding-status
npm run codex -- doctor
npm run codex -- unbind
```

The project file is `.codex/memory-binding.json` and contains only binding IDs
and preferences. The Memory Hub user key is stored separately under the user's
configuration directory (`$XDG_CONFIG_HOME/tencentdb-agent-memory/codex`, or
`~/.config/tencentdb-agent-memory/codex`) with directory mode `0700` and file
mode `0600`; a credential directory inside the bound project is rejected.
Credentials are accepted from environment variables rather than command-line
options so they are not exposed in shell history or process arguments. `unbind
--forget-credential` also removes the key for that Memory service. Status and
unbind are local operations; doctor revalidates the stored IDs with MemoryCore
but never invokes a model.

These credentials have separate roles: `MEMORY_HUB_USER_KEY` authorizes the
user binding and `MEMORY_CORE_SERVICE_TOKEN` authenticates the local integration
to MemoryCore. Neither is the proxy model credential (`PROXY_UPSTREAM_API_KEY`
or `upstream.apiKey`) nor the internal memory-distillation model credential
(`MEMORY_LLM_API_KEY`).

### Codex lifecycle context

The repo-local plugin scaffold is under
`plugins/tencentdb-agent-memory`. Its single thin executable forwards the
documented `SessionStart` and `UserPromptSubmit` JSON payloads to the
loopback-only hook listener. The same executable also forwards `PostToolUse`,
`Stop`, and `SessionEnd`; Codex still calls the model through its own
subscription transport.

Start the sidecar without any proxy upstream credential:

```bash
npm start -- --config config.yaml --mode hooks
```

`SessionStart` handles `startup`, `resume`, `clear`, and `compact`, restoring
ordered session, memory, skill, and knowledge context. Returned context is
delimited and marked `capture=exclude`, secrets are redacted, and complete
blocks are selected deterministically within the output bound. The documented
`transcript_path` field is accepted but is never the primary protocol or read
on this path.

`UserPromptSubmit` durably records the exact `(service, team, user, agent, task,
source, session, turn, prompt)` identity before acknowledging the hook. Add these optional,
non-secret preferences to `.codex/memory-binding.json` to enable per-prompt L1
recall and cap the number of returned blocks:

```json
{
  "preferences": {
    "dynamicRecall": true,
    "contextLimit": 5
  }
}
```

The hook never replaces or rewrites the original prompt. If the sidecar is
unavailable during a context read, the executable returns valid empty hook
output and Codex continues without injected memory.

`PostToolUse` journals the documented tool name, tool-use ID, input, response,
and failed-shell outcome before acknowledgement for observable local shell/exec,
`apply_patch`, and MCP paths. `Stop` durably stores the final assistant message,
then enqueues exactly one L0 user/assistant pair and one full normalized,
tool-aware skill round. Stable session/turn/source identities make duplicate
tool events, repeated `Stop`, and replay after a sidecar restart idempotent.
`SessionEnd` is advisory and is never required to commit a round.

After a successful `SessionStart`, prepared context advertises only the
capabilities enabled for the bound asset. Codex can then use the loopback
sidecar for read-only memory search, visible skill operations, and authorized
Wiki/CodeGraph tools. The sidecar resolves the initialized Codex session,
overwrites caller-supplied identity, enforces the MemoryRuntime capability and
Team/Agent/Task ACL decisions, and forwards only allowlisted operations. These
bridge routes are not exposed through the public proxy catch-all.

Hooks mode also provides model-free management commands. Set the active Codex
session explicitly (or export `CODEX_SESSION_ID`); the sidecar URL defaults to
`http://127.0.0.1:8097` and can be overridden only with another loopback HTTP
URL via `--sidecar-url` or `CODEX_MEMORY_SIDECAR_URL`.

```bash
npm run codex -- mem-help
npm run codex -- sync --session-id "$CODEX_SESSION_ID"
npm run codex -- refresh --session-id "$CODEX_SESSION_ID"  # alias of sync
npm run codex -- force-archive --session-id "$CODEX_SESSION_ID" --reason "capture workflow"
npm run codex -- create-skill --session-id "$CODEX_SESSION_ID" \
  --name migration-checklist --content-file ./SKILL.md
```

`create-skill` still obeys the configured skill write gate. `mem:*` request
interception remains proxy-only; these CLI commands are explicit hooks-mode
equivalents and never replace an assistant response.

Codex does not expose every hosted or specialized tool through `PostToolUse`.
Those events are intentionally omitted; the integration does not infer them
from `transcript_path` or claim exact tool visibility on unsupported paths. If
the sidecar is unavailable during `UserPromptSubmit`, `PostToolUse`, or `Stop`,
the executable exits unsuccessfully instead of acknowledging an unpersisted
write. The install flow above never treats plugin installation as hook trust;
review the active definitions with `/hooks` and record their exact digest before
relying on lifecycle capture.

### 1. Install dependencies

```bash
cd MemoryProxy
npm install
```

### 2. Create the config

Create your own `config.yaml` from the example:

```bash
cp config.example.yaml config.yaml
# adjust upstream / auth / tdai / skill / storage as needed
```

At minimum confirm:

- `runtime.mode` — `proxy` (default), `hooks`, or `both`
- `upstream.url` / `upstream.apiKey` — upstream LLM address and credentials (not required in `hooks` mode)
- `auth.url` / `tdai.endpoint` / `skill.endpoint` — point to your MemoryCore Gateway (default `http://127.0.0.1:8420`)

> **Run locally without Redis**: the example config defaults to `redis.enabled: true`, which spams `ECONNREFUSED 127.0.0.1:6379` when no Redis is running locally. For pure local development, set `redis.enabled: false` + `storage.enabled: true` (`storage.backend: sqlite`); session/injection/Skill state then goes to local SQLite and the process starts up cleanly.

### 3. Start the service

```bash
npm run start:config
# equivalent to:
node --import tsx/esm src/index.ts --config config.yaml
```

Use `--mode hooks` for a loopback-only hook sidecar, or `--mode both` for the
public proxy and local hook listeners in one process. The hook listener defaults
to `127.0.0.1:8097` and is configured under `runtime.hooks`; it cannot be bound
to a non-loopback address.

### 4. Health check

```bash
curl http://127.0.0.1:8096/health
```

Sample response (`storage.effective` is the observability anchor for the storage backend):

```json
{
  "status": "ok",
  "version": "0.2.0",
  "mode": "both",
  "upstream": "configured",
  "listeners": {
    "proxy": { "enabled": true, "ready": true, "host": "0.0.0.0", "port": 8096 },
    "hooks": { "enabled": true, "ready": true, "host": "127.0.0.1", "port": 8097 }
  },
  "storage": { "enabled": false, "requested": "sqlite", "effective": "sqlite", "degraded": false }
}
```

## Ways to start

```bash
# Direct start (built-in defaults, not for production)
npm start

# With a config file
npm run start:config

# CLI overrides (highest priority)
node --import tsx/esm src/index.ts --port 9000 --upstream https://other.api/v1

# Dev mode (auto-restart on file change)
npm run dev:config
```

### Background script `proxy.sh`

Always uses `./config.yaml`, auto-detects the `node` path (nvm / fnm compatible), and writes logs by date to `logs/YYYY-MM-DD.log`.

```bash
./proxy.sh start          # start in background
./proxy.sh stop           # stop
./proxy.sh restart        # restart
./proxy.sh status         # status (includes /health output)
./proxy.sh log            # tail today's log

./proxy.sh daemon         # daemon mode (auto-restart on crash)
./proxy.sh daemon-stop
./proxy.sh daemon-status
```

## Client configuration

Point the coding agent's upstream address at this proxy and keep the rest (`apiKey`, `model`, ...) unchanged. Include `spaceId` (memory instance id) in the path — the proxy auto-extracts it for auth, injection and billing.

OpenAI-compatible client:

```json
{
  "apiKey": "sk-mem-xxx",
  "url": "http://localhost:8096/proxy/<spaceId>/v1/chat/completions"
}
```

Anthropic Messages client:

```json
{
  "apiKey": "sk-mem-xxx",
  "url": "http://localhost:8096/proxy/<spaceId>/v1/messages"
}
```

## Main HTTP endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/proxy/<spaceId>/v1/chat/completions` | OpenAI-compatible main-model call (with memory instance id) |
| `POST` | `/proxy/<spaceId>/v1/messages` | Anthropic Messages main-model call |
| `POST` | `/v1/messages` | Anthropic Messages API (fallback without spaceId) |
| `POST` | `/*` | OpenAI-compatible chat endpoint (catch-all) |
| `ALL`  | `/skill-bridge/**` | reverse-proxy for MemoryCore skill HTTP tools |
| `ALL`  | `/memory-bridge/**` | reverse-proxy for MemoryCore memory HTTP tools |
| `POST` | `/v3/instance/proxy-destroy` | ops endpoint: clear COS cache on instance destroy |
| `GET/PUT/DELETE` | `/v3/admin/rate-limits` | query / modify per-instance × model TPM/QPM |
| `GET`  | `/health` | runtime health check (includes `storage.effective`) |
| `GET`  | `/whoami` | API Key → keyId (plain text, handy with curl) |

## Configuration

See the fully-commented [`config.example.yaml`](./config.example.yaml). Precedence: **CLI args > YAML config file > built-in defaults**.

Config sections at a glance:

| Section | Purpose |
| --- | --- |
| `runtime` | process mode (`proxy` / `hooks` / `both`) and loopback hook listener |
| `server` | listen host / port, upstream forward timeout |
| `upstream` | default upstream URL and global `apiKey` (replaces forward auth when non-empty) |
| `log` | log directory, level, backend and rotation policy |
| `redis` | default backend for session / injection / Skill state (used when `storage.enabled` is off) |
| `storage` | unified storage abstraction (`cos` / `sqlite` / `fs` / `memory`); `cos` preferred for multi-node |
| `auth` | `x-tdai-user-key` → `user_id` validation (calls MemoryCore `/v3/meta/auth/verify`) |
| `admin` | shared secret for ops endpoints (e.g. `/v3/instance/proxy-destroy`) |
| `systemUsers` | internal service accounts; short-circuit passthrough on match |
| `injection` | master switch and injector list (`skill` / `knowledge` / `tdai-memory`) |
| `extraction` | conversation write-back master switch (skill archival + L0 write) |
| `sessionInit` | session init form flow and header auto pre-select policy |
| `tdai` | MemoryCore connection and L0/L1/L2/L3 switches |
| `skill` | MemoryCore data-plane config (Skill RAG, Skill archival, Meta) |
| `knowledge` | standalone knowledge gateway (may differ from skill) |
| `skillRuntime` | whether the main model may write Skills (read-only by default) |
| `rateLimit` | Input TPM / QPM limiting per memory instance × actual model |
| `clickhouse` | per-turn usage reporting (billing data source) |
| `creditReport` / `creditPricing` | Credit billing report and pricing table |
| `upstream.agents` | override upstream URL + apiKey per agent name (e.g. route `claude-code` through CCR) |

> `injection`, `extraction`, `sessionInit`, `tdai`, `skill`, `knowledge`, `skillRuntime` are the memory-related sections — focus on them first when integrating.

### Common environment variables

```bash
TDAI_MEMORY_SYSTEM_USER_ID   # user_id of the memory internal service account
TDAI_MEMORY_SYSTEM_USER_KEY  # apiKey of the memory internal service account (ops reference only)
TDAI_PROXY_ADMIN_API_KEY     # shared secret for ops endpoint auth
PROXY_DB_PATH                # sqlite backend db path (used when storage.sqlite.dbPath is empty)
```

## Choosing a storage backend

With `storage.enabled=true`, all session/injection/Skill state (`inj:*` / `sk:*` / `vpin:*`) goes through ProxyStorage:

| Backend | Use case | Notes |
| --- | --- | --- |
| `cos` | Production multi-node | cross-node sharing; kernel-sts only (one temp credential per spaceId) |
| `sqlite` | Single-instance local dev / CI | built-in sweeper periodically clears the `ttl/` bucket; `nottl/` is kept forever |
| `fs` | Offline / docker fallback | no sweeper; delegate to external tmpwatch |
| `memory` | Fallback / testing | cleared on process restart |

The key layout is uniformly `proxy_cache/{ttl|nottl}/{spaceId}/{userId}/{agentSource}/{sessionId}/...`; `ttl/` holds hot cache (rebuildable), `nottl/` holds business state such as bindings that must persist.

Degradation chain: `cos → sqlite → fs → memory`. If any backend fails to init, it degrades automatically, and the `/health` endpoint exposes `storage.effective` as the observability anchor.

## Docker

The image runs TypeScript directly via tsx, uses `tini` as PID 1, runs as a non-root user, and ships a `/health` `HEALTHCHECK`. The multi-stage build requires BuildKit.

Build in the `MemoryProxy/` directory:

```bash
DOCKER_BUILDKIT=1 docker build -t memory-proxy:local .
```

Run the container (config provided by mounting `/data/config.yaml`; sqlite storage persisted to `/data/tdai-memory-proxy`):

```bash
docker run --rm \
  -p 8096:8096 \
  -v "$PWD/config.yaml:/data/config.yaml:ro" \
  -v tdai-proxy-data:/data/tdai-memory-proxy \
  -e TDAI_PROXY_ADMIN_API_KEY="replace-with-a-strong-random-token" \
  memory-proxy:local
```

- The default config path is `/data/config.yaml`; override it by appending `--config /other/path.yaml` to `docker run`.
- Inject credentials via environment variables or a Secret Manager; never bake API keys / STS credentials into the image or config repo.
- Health status: `docker inspect --format '{{.State.Health.Status}}' <container>`.

## Directory structure

```text
MemoryProxy/
  src/
    index.ts / server.ts              entry point and HTTP routing
    handler.ts / anthropicHandler.ts  OpenAI / Anthropic request handlers
    auth.ts / identity.ts             user identity and authentication
    systemUser.ts / systemUserPassthrough.ts  internal-account short-circuit passthrough
    session/                          session init: form flow, state store, Claude Code / CodeBuddy adapters
    injection/                        injection pipeline: skill / knowledge / tdai-memory injectors
    skill/                            Skill Bridge, conversation/add archival trigger, version pin
    memory/                           Memory Bridge reverse proxy
    knowledge/ / meta/                MemoryCore knowledge / metadata clients
    tdai/                             Memory L0/L1/L2/L3 client, pending-write queue
    storage/                          ProxyStorage abstraction (cos / sqlite / fs / memory)
    db/                               session / injection / Skill state persistence repos
    rate-limit/                       Input TPM / QPM limiting
    routes/                           admin endpoints (admin-auth / instance-destroy / rate-limits)
    clickhouse.ts / langfuse.ts / opik.ts  three observability channels
    credit-reporter.ts / pricing.ts   Credit billing report and pricing
    report/ / logger.ts               structured logging system and JSONL usage log
  gateway/                            optional load-balancing gateway (keyId consistent hashing)
  docs/                               architecture, design docs and e2e runbooks
  scripts/                            smoke, migration, maintenance scripts
  config.example.yaml                 fully-commented complete config example
  Dockerfile                          MemoryProxy image
  proxy.sh                            background start / daemon script
  package.json
```

## Running tests

```bash
npm test              # vitest run (unit + integration by default)
npm run test:watch
```

`__tests__/` live under each submodule: `session/__tests__` (session flow), `skill/__tests__` (archival trigger, version pin), `storage/__tests__` (backend contracts), `db/__tests__` (repo consistency), etc. `docs/` also provides several end-to-end runbooks (`e2e-runbook.md` / `e2e-full-coverage-runbook.md`, ...) for verifying the memory pipeline against a real MemoryCore + Redis + storage backend.

## Security & release notes

- When listening on a non-loopback address or deploying multi-node, enable `auth.enabled=true` and inject `TDAI_PROXY_ADMIN_API_KEY` via env to protect ops endpoints.
- Inject all secrets via environment variables or a Secret Manager; never commit real `apiKey` / `serviceToken` / STS credentials / billing URLs into the config repo.
- For multi-node deployments you must use `storage.backend=cos` and explicitly set `injection.externalGatewayUrl`, otherwise each instance caches independently and causes upstream KV-cache misses.
- Do not commit generated data, local databases, logs or env files (`logs/`, `*.db`, `.env`, `dump.rdb`, `session*.json`, `*.pid`, ...).

## License

MIT
