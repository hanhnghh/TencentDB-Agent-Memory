# Coding Standards

These standards guide review across a multi-package repository. Apply the rules and tooling of the package being changed; avoid repository-wide style normalization. Preserve existing public behavior unless the issue or parent PRD explicitly changes the contract.

## Review Scope

- Keep refinements inside the issue and branch diff. Treat unrelated cleanup, dependency upgrades, generated-file churn, and broad formatting as separate work.
- Prefer the smallest complete change at the highest useful seam. Keep transport concerns, memory semantics, persistence, and presentation behind explicit interfaces rather than sharing wire-format objects across layers.
- Follow the touched module's established quote, import, and file-layout style. Backend packages predominantly use double quotes; `MemoryPanel/web` is formatted by its Prettier configuration with single quotes. Do not restyle neighboring code merely for consistency.
- Preserve backward compatibility for existing proxy, gateway, SDK, configuration, and storage contracts unless the governing issue explicitly approves a migration.
- Use English for new identifiers and public API names. Comments may follow the surrounding file's language, but must explain a contract, invariant, or non-obvious reason rather than restate the code.

## TypeScript and Module Boundaries

- Services and TypeScript SDKs are ESM. Follow the local module-resolution convention, including `node:` prefixes for built-ins and `.js` suffixes for relative runtime imports where the package already requires them.
- Keep strict TypeScript valid. Model unknown boundary data as `unknown`, validate it, then narrow it. Avoid new `any`, unchecked type assertions, non-null assertions, and casts through `unknown` unless the invariant is both unavoidable and documented.
- Prefer schema-derived or shared domain types over duplicate request/response shapes. Keep wire names such as `team_id` and `source_event_id` at API boundaries; use the surrounding module's internal naming convention behind the boundary.
- Use descriptive named types for identity, lifecycle events, receipts, and state transitions. Represent mutually exclusive states with discriminated unions rather than optional-boolean combinations.
- Keep public module interfaces deep: callers should request an outcome, not orchestrate provider calls, cache policy, retries, or persistence steps themselves.
- Pass infrastructure through existing dependencies or ports. Avoid module-level mutable singletons unless the package already owns that process-wide lifecycle and tests can reset it.
- Keep functions focused on one level of abstraction. Extract a helper when it hides a meaningful policy or invariant, not merely to shorten a function.

## API Contracts and Validation

- Validate all external HTTP, CLI, hook, environment, and configuration input at the boundary. Use the package's existing Zod schemas and `safeParse`/formatted validation errors for gateway routes.
- Preserve the gateway response envelope and request correlation conventions. Client-safe errors must not expose internal stack traces, storage paths, credentials, or raw dependency responses.
- Make public contract changes end to end: canonical schema, hand-written overrides, handler, client, supported SDKs, examples, and contract tests must agree.
- Add fields compatibly when possible. Optional request fields must retain legacy behavior when omitted; a breaking default or requirement needs an explicit migration decision.
- Do not hand-edit `MemoryCore/src/gateway/generated`. Change the canonical API description or generator configuration and regenerate it; keep non-generatable refinements in the established hand-written schema layer.
- Preserve documented error semantics. Distinguish invalid input, unauthenticated access, forbidden ownership combinations, hidden/not-found resources, conflicts, throttling, dependency failures, and internal errors.
- Strip `undefined` values before serialization when omission is part of the wire contract. Do not silently convert malformed success payloads into empty success objects.

## Identity, Authorization, and Privacy

- Carry the full applicable isolation tuple through every read, write, cache key, receipt, and binding: service/space, team, user, agent, task, agent source, and session. Never reconstruct a narrower key when a scoped identity is available.
- Validate Team/Agent/Task ownership and visibility through the authoritative metadata/ACL layer. Authorization uncertainty is fail-closed; a dependency outage must not broaden access.
- Keep intentional read-path degradation explicit. Context recall may fail soft when the caller can safely continue without memory; authorization checks and write acknowledgement must not fail soft.
- Treat project binding files as non-secret configuration. API keys, bearer tokens, authorization headers, cookies, and service credentials belong in protected user/runtime storage.
- Redact secrets and user content from logs and diagnostics. Log stable correlation identifiers, state, latency, counts, and safe error classification instead of full prompts, tool results, memory payloads, or hidden reasoning.
- Server-side bridges must overwrite caller-supplied identity with the validated session identity and enforce the same capability/ACL gates as direct APIs.

## Persistence, Concurrency, and Failure Semantics

- A success acknowledgement means the authoritative write succeeded. Check storage return values and propagate typed failures; never catch a write error and return an empty success-shaped object.
- Make retryable writes idempotent end to end. Use stable source-event identity, content validation, deterministic record identity or an atomic receipt, and return the prior receipt for a safe duplicate.
- Serialize mutations that share a session buffer or use an atomic transaction, CAS/version, or immutable event journal. Read-modify-write against shared state without conflict protection is not acceptable.
- Persist durable work before acknowledging a short-lived hook or request. Background delivery must have bounded retries, startup replay, terminal/dead-letter state, and observable health.
- Await writes whose durability is part of the method contract. Fire-and-forget work must be explicitly non-critical, attach rejection handling, and be drainable when process shutdown matters.
- Use `AbortController`/timeouts for remote calls and clear timers in `finally`. Classify network, timeout, throttling, server, client, and malformed-response failures before applying retry policy.
- Keep caches as accelerators, not sources of authority. Cache misses and process restarts must recover from the scoped durable source without crossing identities.

## MemoryCore and Skill Isolation

- Preserve the L0/L1/L2/L3 data meanings and existing normalization rules unless the issue changes them explicitly. L0 conversation input and tool-aware skill input are separate contracts.
- Skill production code uses the storage abstraction; it must not import `node:fs`, `fs`, or `fs/promises` directly. Test scaffolding may use temporary filesystem helpers.
- Changes under `MemoryCore` must pass the skill queue isolation guard. Protected memory state, pipeline-worker, and memory Redis areas require an explicit architectural change rather than an incidental skill refactor.
- Preserve same-session ordering for skill conversation ingestion and keep user, assistant, tool-call, and tool-result identities paired during normalization.
- System instructions, hidden reasoning, images, and injected memory context are excluded from conversational write-back unless a public contract explicitly says otherwise.

## Error Handling and Observability

- Use the module's logger and established envelope/classification helpers. Avoid introducing `console` logging in request-path production code where structured logging is available.
- Include correlation by request/session/turn/source-event ID where available, but keep logs valid when optional identifiers are absent.
- Log once at the layer that owns the recovery decision. Lower layers should return or throw useful typed errors rather than log-and-swallow the same failure.
- Keep degraded behavior visible through diagnostics or metrics without turning optional telemetry failures into user-facing request failures.

## Frontend

- `MemoryPanel/web` follows its ESLint, React Hooks, TypeScript, and Prettier configurations. Use function components and obey hooks rules and dependency checks.
- Route user-visible text through the existing i18n system. Keep supported locale resources synchronized when adding or changing labels, errors, or help text.
- Model server state, loading, empty, error, and permission-denied states explicitly. Do not infer authorization from hidden or disabled UI controls; the server remains authoritative.
- Preserve accessibility semantics for interactive elements, keyboard use, labels, and status feedback.

## Python and Shell

- Python SDK code follows PEP 8, uses type annotations for public APIs, and preserves sync/async client symmetry where both surfaces exist.
- Raise the SDK's established typed exceptions for transport, HTTP, API-envelope, and parameter failures. Keep wire models and defaults aligned with the TypeScript SDK.
- Bash scripts use Bash explicitly, enable `set -euo pipefail` for non-trivial flows, quote expansions, validate required inputs before mutation, and keep secrets out of generated logs and command traces.
- Deployment scripts must validate only dependencies required by the selected mode and remain non-interactive unless the command is explicitly an installer or wizard.

## Tests

- Add a regression test before or with every behavior change and bug fix. Assert externally visible outcomes at the highest practical seam; avoid tests coupled to private helper order or class layout.
- Cover the failure path that motivates reliability code: duplicate delivery, lost acknowledgement, storage failure, timeout, restart/replay, concurrent same-session work, invalid identity, or permission denial as applicable.
- Keep unit and contract tests deterministic. Use injected clocks/IDs, temporary directories, in-memory adapters, or mocked transports instead of real network services and developer-machine state.
- Reset mocks, environment variables, timers, singleton registries, and durable test state between cases. Tests must pass independently and in arbitrary order.
- When a public gateway contract changes, test both server behavior and each supported SDK surface. When generated output changes, test the canonical source and regenerated consumer contract rather than editing snapshots alone.
- Preserve proxy regression coverage for streaming and non-streaming responses, headers, model routing, client-key passthrough, bridge routes, and session classification whenever shared orchestration changes.

## Validation

Run validation from every changed package; the repository root is not a substitute for module-local checks.

- `.sandcastle` orchestration: run `node --test .sandcastle/workflow-policy.test.mts`, then `npx tsc -p .sandcastle/tsconfig.json`. Resume/review policy changes must include a regression for branches that are already ahead of base but create no new commit in the current agent invocation.

- `MemoryCore`: run the relevant Vitest suite and `npm run build:plugin` when runtime exports change. Run `npm run lint:skill-isolation` for skill/core changes. The aggregate `npm run build` is not an authoritative gate while the unchanged repository is missing `scripts/seed-v2/tsconfig.json`; do not rerun it to re-establish that baseline.
- `MemoryProxy`: run the focused Vitest suite, then `npm test`. From the repository root run `/home/agent/check-memory-proxy-types.sh`; it accepts only the six documented baseline diagnostics and fails on every new TypeScript diagnostic. Do not replace it with raw `npx tsc --noEmit` during implementation or review.
- `MemoryKnowledge`: run `npm run typecheck`, `npm test`, and build checks for exported/server changes.
- `MemoryPanel`: run backend typecheck/tests when backend code changes. In `MemoryPanel/web`, run `npm run lint:check`, `npm run format:check`, and `npm run build`.
- TypeScript SDK: run `npm test` and `npm run build`. Python SDK: run `python -m pytest -q` and `python -m build --no-isolation`; the sandbox image already supplies its declared runtime, build backend, and dev tools.
- Shell/deployment changes: run `bash -n` on changed scripts and the narrowest safe verification path; use ShellCheck when available.
- Install package dependencies once when the required executable is absent, then reuse them for focused and package gates. Report missing dependencies or pre-existing failures separately. Never claim validation that did not run.

## Repository Hygiene

- Respect the package manager and lockfile already used by the touched module. Avoid unrelated lockfile regeneration and do not introduce a second dependency version without a demonstrated need.
- Keep generated artifacts, build output, local databases, credentials, and developer-specific configuration out of commits.
- Update English and Chinese user documentation together when a user-facing contract, configuration, installation step, or CLI behavior changes.
- Commits follow the repository's Conventional Commit scopes and include DCO sign-off. Review-only commits should describe the refinement without claiming a behavior change.
