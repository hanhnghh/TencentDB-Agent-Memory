# Sandcastle setup checklist for Agent Memory

This repository uses GitHub Issues directly:

```text
GitHub Issues -> planner -> implementer -> reviewer -> verified merger -> GitHub close
```

GitHub Issues is the sole tracker. Agents discover and update work with `gh` inside their Docker sandbox.

## 1. Install the runner

From the repository root:

```bash
npm install
npx sandcastle --help
npx tsx --version
```

The root package contains only the Sandcastle orchestration dependencies. Product validation runs from `MemoryCore`, `MemoryProxy`, `MemoryKnowledge`, `MemoryPanel`, or the affected SDK package.

Completion criterion: `npx tsx --version` and `npx sandcastle --help` exit successfully.

## 2. Configure GitHub Issues authentication

Copy the environment template and provide a fine-grained token:

```bash
cp .sandcastle/.env.example .sandcastle/.env
```

Set `GH_TOKEN` with repository permissions:

- Metadata: read
- Issues: read and write

The planner calls `gh issue list --label ready-for-agent` itself. It reads `## Blocked by` from issue bodies and verifies blocker state with `gh issue view`. The label marks a candidate; it does not override an open blocker.

Completion criterion:

```bash
GH_TOKEN="$(sed -n 's/^GH_TOKEN=//p' .sandcastle/.env)" \
  gh issue list --state open --label ready-for-agent --limit 1
```

The command returns successfully without printing the token.

## 3. Build the project-specific image

The image provides:

- Node.js 22 and Corepack for the TypeScript services and SDK;
- Python 3 plus venv/build headers for the Python SDK;
- the Python SDK's declared test/build dependencies in a shared image venv;
- build tools and SQLite headers for native Node/SQLite dependencies;
- `git`, `gh`, `jq`, `rg`, `shellcheck`, and `sqlite3` for agent work and feedback;
- Codex CLI running as a host-aligned non-root user.

Build and smoke-test it:

```bash
npx sandcastle docker build-image

# If the Sandcastle CLI leaves an older cached image, rebuild explicitly:
docker buildx build --load \
  --tag sandcastle:tencentdb-fork-agent-memory \
  --build-arg AGENT_UID="$(id -u)" \
  --build-arg AGENT_GID="$(id -g)" \
  --file .sandcastle/Dockerfile \
  .sandcastle

docker run --rm --entrypoint sh sandcastle:tencentdb-fork-agent-memory -c \
  'node --version && corepack --version && python --version && pytest --version && sqlite3 --version && gh --version && codex --version && shellcheck --version'
```

If Sandcastle reports a different generated image name, use that name in the smoke test.

Completion criterion: every executable referenced by the prompts works as the non-root agent.

## 4. Authenticate Codex with the ChatGPT subscription

Sandcastle keeps this login separate from the normal host Codex installation. `main.mts` mounts:

```text
host:      .sandcastle/codex-home
container: /home/agent/.codex
```

The directory is ignored by Git. On first runner startup, `main.mts` creates a private `config.toml` containing:

```toml
cli_auth_credentials_store = "file"
forced_login_method = "chatgpt"
```

Build the image, then perform device-code login with the same mount:

```bash
mkdir -p .sandcastle/codex-home

docker run --rm -it \
  -e HOME=/home/agent \
  -e CODEX_HOME=/home/agent/.codex \
  -v "$PWD/.sandcastle/codex-home:/home/agent/.codex" \
  --entrypoint codex \
  sandcastle:tencentdb-fork-agent-memory \
  -c 'cli_auth_credentials_store="file"' \
  -c 'forced_login_method="chatgpt"' \
  login --device-auth
```

Follow the browser/device-code flow. Do not place `OPENAI_API_KEY` or `OPENAI_KEY` in `.sandcastle/.env`.

Verify the isolated session:

```bash
docker run --rm \
  -e HOME=/home/agent \
  -e CODEX_HOME=/home/agent/.codex \
  -v "$PWD/.sandcastle/codex-home:/home/agent/.codex" \
  --entrypoint codex \
  sandcastle:tencentdb-fork-agent-memory \
  login status
```

Completion criterion: `login status` exits zero and reports ChatGPT authentication. Treat `.sandcastle/codex-home/auth.json` as a password.

## 5. Understand the feedback gates

A feedback loop answers whether the last small change was correct:

```text
small vertical slice -> focused red/green check -> package integration gate
-> inspect failure -> correct -> rerun -> review
```

It is not the outer Sandcastle backlog loop. The outer loop only selects the next GitHub Issues; the inner feedback loop makes each implementation trustworthy.

Use the domain loop matching the issue:

- MemoryCore: schema → handler/storage receipt → duplicate behavior → SDK/contract test.
- Shared runtime/proxy parity: canonical fixture → prepare/commit seam → unchanged observable memory outcome.
- Codex hooks/durability: event → session/round classification → ledger/outbox → Core receipt → duplicate/restart test.
- Deployment: runtime mode → startup validation → listeners/health smoke check.

The exact package commands and invariants are maintained once in `CODING_STANDARDS.md`. Implementer, reviewer, and merger all read that file and run module-local gates. A required failing or unexecuted check keeps the branch out of the merge batch.

Completion criterion: deliberately breaking the focused behavior turns its loop red; restoring it and running the affected package gate turns it green.

## 6. Validate the orchestration contracts

Check that every prompt placeholder is supplied, the planner owns GitHub discovery, and every sandbox uses the isolated Codex mount:

```bash
rg -n 'gh issue list|gh issue view|gh issue close' .sandcastle/*-prompt.md
rg -n 'sandbox: codexSandbox\(\)' .sandcastle/main.mts
rg -n '\{\{[A-Z_]+\}\}' .sandcastle/*.md
```

Expected results:

- the first command shows planner discovery, ticket loading, and verified closure;
- every phase in `main.mts` uses the shared `codexSandbox()` provider;
- placeholders are limited to values supplied by `main.mts` plus Sandcastle built-ins.

Then run static validation:

```bash
npm run typecheck:sandcastle

git diff --check
git check-ignore -v \
  .sandcastle/.env \
  .sandcastle/codex-home/auth.json \
  .sandcastle/logs/example.log \
  .sandcastle/worktrees/example
```

Completion criterion: TypeScript and whitespace checks pass and every credential/runtime path is ignored.

## 7. Run one observed round

Start from a named integration branch. The project currently processes one
issue at a time so shared Core/proxy contracts cannot race:

```bash
npx tsx .sandcastle/main.mts
```

Observe logs from a second terminal:

```bash
tail -f .sandcastle/logs/*.log
```

After the round, verify:

- planner selected only actionable child tickets whose blockers are closed;
- independent tickets ran concurrently and conflicting tickets did not;
- each mergeable branch has implementer and reviewer evidence;
- reviewer completion required green package-local feedback;
- merger reran cumulative gates before closing the corresponding GitHub Issue;
- failed or unverified branches remained open with durable issue context;
- no secret or Codex state appears in Git status.

## Definition of done

The setup is ready when one real ticket completes this path without manual tracker or credential repair:

```text
open ready-for-agent child issue
  -> planner verifies blockers through GitHub
  -> isolated Codex subscription sandbox
  -> vertical-slice implementation with red/green feedback
  -> specification and standards review
  -> cumulative verified merge
  -> GitHub issue close
  -> newly unblocked issue becomes eligible
```
