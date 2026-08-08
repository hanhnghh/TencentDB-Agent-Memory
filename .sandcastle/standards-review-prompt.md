# Task

Perform an independent coding-standards review of branch `{{BRANCH}}` for
GitHub Issue #{{TASK_ID}}: {{ISSUE_TITLE}}. Correct in-scope violations when
necessary.

Read `/home/agent/CODING_STANDARDS.md` completely. Load the issue only to
understand the diff boundary, then inspect:

```bash
git log {{BASE_BRANCH}}..HEAD --oneline --decorate
git diff {{BASE_BRANCH}}...HEAD --stat
git diff {{BASE_BRANCH}}...HEAD
```

# Standards review

Review every changed file against the standards, with particular attention to:

- unchecked assertions, casts through `unknown`, duplicated boundary shapes,
  and mocks that bypass real public clients;
- the full applicable service/space/team/user/agent/task/source/session identity
  tuple in keys, receipts, caches, and bindings;
- authorization fail-closed behavior, identity overwrite at bridges, secret
  handling, durable acknowledgement, idempotency, and same-session ordering;
- deterministic tests, resettable state, real public seams, and absence of
  tautological assertions;
- repository hygiene, generated-contract policy, Conventional Commits, and DCO.

Do not infer that passing tests imply standards compliance. Correct every
in-scope violation, add regression evidence where behavior changes, and run the
authoritative gates in `/home/agent/CODING_STANDARDS.md`. Commit corrections
with a Conventional Commit subject and DCO sign-off.

Report findings and exact commands. Emit `<promise>COMPLETE</promise>` only when
the standards diff review and all required gates are green. Do not re-decide
specification completeness in this role; the independent spec reviewer owns
that axis.
