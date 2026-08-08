# Task

Review and, when necessary, correct branch `{{BRANCH}}` for GitHub Issue #{{TASK_ID}}: {{ISSUE_TITLE}}.

Load the issue and its referenced parent PRD with `gh issue view`. Read `/home/agent/CODING_STANDARDS.md` completely; it is the integration branch's read-only standards mount.

# Evidence

Inspect the branch history and changed files:

```bash
git log {{BASE_BRANCH}}..HEAD --oneline --decorate
git diff {{BASE_BRANCH}}...HEAD --stat
git diff {{BASE_BRANCH}}...HEAD
```

Use the issue acceptance criteria and actual branch diff as the review boundary. Do not broaden the ticket into unrelated cleanup.

# Review

Review both axes:

1. **Specification:** the vertical slice satisfies every ticket acceptance criterion and preserves the parent PRD's proxy-observable memory parity.
2. **Standards:** every changed file follows `/home/agent/CODING_STANDARDS.md`, especially identity isolation, capability gates, idempotent receipts, same-session ordering, durable retry, failure classification, secret handling, and generated-contract policy.

Trace externally visible behavior rather than trusting helper-level tests. For reliability changes, actively look for duplicate delivery, lost acknowledgement, crash/restart replay, concurrent same-session work, malformed success responses, and fail-open authorization. For shared runtime changes, compare OpenAI/Anthropic legacy outputs against the extracted path.

# Feedback gate

Run the narrowest test that can turn red for each identified risk, then run every authoritative module-local type-check/test/build/guard required for the changed packages. Use the command matrix in `/home/agent/CODING_STANDARDS.md`. Its baseline-aware commands are authoritative; do not rerun raw equivalents merely to investigate already documented baseline failures.

When a check fails: diagnose the cause, apply the smallest in-scope correction, rerun the failing check, then rerun the affected package gate. Repeat until green. Add regression coverage for every defect corrected during review.

Commit corrections with a Conventional Commit subject and DCO sign-off. If no correction is needed, create no review-only commit.

Emit `<promise>COMPLETE</promise>` only when specification review, standards review, and all required feedback gates are green. A red or unexecuted required gate is not complete.
