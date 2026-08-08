# Task

Implement GitHub Issue #{{TASK_ID}}: {{ISSUE_TITLE}} on branch `{{BRANCH}}`.

Load the complete issue with:

```bash
gh issue view {{TASK_ID}} --json number,title,body,labels,comments
```

If the body references a parent PRD, load that issue too. The ticket defines scope; the PRD defines the wider contract. Work on this ticket only.

# Required context

Read `/home/agent/CODING_STANDARDS.md` completely before editing. It is a read-only mount from the integration branch, so existing issue branches receive the current standards without rebasing. Inspect the relevant package manifests, existing tests, and the last ten commits. Preserve unrelated working-tree changes.

# Execution: tracer-bullet feedback loop

Work in the smallest observable vertical slice that crosses every layer required by this ticket. Do not build all schemas, then all services, then all adapters before obtaining feedback.

For each slice:

1. **RED** — add or select a focused characterization/regression test that demonstrates the missing behavior or parity invariant.
2. **GREEN** — implement the smallest end-to-end path that makes the focused check pass.
3. **INTEGRATE** — run the nearest type-check/build/contract check covering every touched boundary.
4. **CORRECT** — inspect failures, fix their cause, and rerun the same command until green.
5. **REPEAT** — take the next observable slice; refactor only while the loop remains green.

Choose the domain loop that matches the ticket:

- **MemoryCore contract:** request schema → handler/storage receipt → duplicate behavior → SDK/contract test.
- **Memory runtime parity:** canonical fixture → prepare/commit seam → unchanged proxy-observable memory outcome.
- **Codex hook durability:** hook event → session/round classification → ledger/outbox → Core receipt, including retry, duplicate, and restart behavior.
- **Deployment:** selected runtime mode → startup validation → listener/health smoke check.

Run commands from each changed package. The authoritative command matrix and security/reliability invariants live in `/home/agent/CODING_STANDARDS.md`; the repository root is not a substitute for module-local validation. Use its baseline-aware commands exactly and do not re-prove a documented repository baseline failure with ad hoc variants. Install dependencies only when the package executable is absent, only in the package that needs them, and respect its existing package manager and lockfile. Reuse the mounted npm, pnpm, and pip caches.

# Completion gate

Before committing:

- every changed behavior has focused regression evidence;
- every required module-local test, type-check, build, isolation guard, or shell check is green;
- parity-sensitive changes compare old proxy behavior with the extracted/shared path;
- skipped environment-dependent checks and pre-existing failures are reported explicitly.

A failed in-scope check keeps the gate red. Continue fixing and rerunning; never describe an unexecuted check as passing.

# Commit and issue state

Commit green work with a Conventional Commit subject and DCO sign-off, for example:

```bash
git commit -s -m "feat(memory-proxy): extract prepared context runtime"
```

Use the commit body for the issue/PRD reference and important design decisions when needed.

If genuinely blocked, leave a concise GitHub comment containing completed work, the exact blocker, and failing command/output summary. Leave the issue open.

Emit `<promise>COMPLETE</promise>` only after the ticket acceptance criteria and completion gate are satisfied. Do not close the issue; the verified merge phase owns closure.
