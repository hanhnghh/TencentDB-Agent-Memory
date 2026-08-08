# Task

Select exactly one executable GitHub Issue for this Sandcastle round. This
repository is intentionally sequential while shared memory contracts are being
established.

GitHub Issues is the source of truth. Load candidates yourself:

```bash
gh issue list \
  --state open \
  --label ready-for-agent \
  --limit 100 \
  --json number,title,body,labels,comments
```

Inspect individual issues with `gh issue view <number>` when their dependency or scope is unclear.

# Eligibility

An issue is executable when all of these hold:

1. It is an implementation ticket, not a parent PRD or tracking issue.
2. Every issue referenced under `## Blocked by` is closed. `None` means no declared blocker.
3. Its acceptance criteria can be implemented without an unresolved product or interface decision.
4. It can run concurrently with every other selected issue without conflicting migrations, schemas, shared interfaces, or overlapping ownership of the same files.

The `ready-for-agent` label identifies candidates; it does not override `## Blocked by`. Query blocker state with `gh issue view <number> --json state` rather than guessing.

Before selecting new work, inspect local `sandcastle/issue-*` branches. Prefer
continuing the lowest-numbered eligible issue whose deterministic branch already
contains commits not present in the base branch. Otherwise select the earliest
dependency or lowest issue number. An all-blocked backlog produces an empty
batch.

Assign each selected issue the deterministic branch `sandcastle/issue-{number}`.

# Output

Return only this JSON object wrapped in `<plan>` tags:

<plan>
{"issues":[{"id":"42","title":"Fix auth bug","branch":"sandcastle/issue-42"}]}
</plan>

Always emit the tags. With no executable work, emit `<plan>{"issues":[]}</plan>`.
