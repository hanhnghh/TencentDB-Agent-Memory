# Task

Perform an independent specification review of branch `{{BRANCH}}` for GitHub
Issue #{{TASK_ID}}: {{ISSUE_TITLE}}. Correct in-scope defects when necessary.

Load the complete issue and every referenced parent PRD with `gh issue view`.
Inspect `git diff {{BASE_BRANCH}}...HEAD` and the branch history. The issue sets
the slice boundary; every validation decision and named scenario in the parent
PRD that applies to this slice remains part of the contract.

# Atomic requirement matrix

Before judging the diff, expand the specification into atomic rows. Include:

- every issue acceptance criterion;
- every explicitly named protocol, lifecycle state, failure path, edge case,
  boundary value, and compatibility surface in the applicable PRD section;
- observed legacy behavior and approved target behavior as separate rows.

For each row record `ID | source | requirement | public seam | exact test name |
command | verdict`. “Representative coverage” is not sufficient when the spec
enumerates multiple cases. A passing suite cannot prove a case for which no
test exists.

# Review and correction

Trace externally visible behavior at HTTP, hook, CLI, storage receipt, or
published module seams. Reject helper-only or tautological tests when the
contract claims route/lifecycle behavior. Approved target behavior that is
intentionally deferred must still be executable as a clearly named
expected-failure test at the real seam so the legacy behavior is not frozen as
the target.

For every missing or incorrect row, add the narrowest in-scope regression and
correction. Run the focused red-capable test, then all authoritative package
gates from `/home/agent/CODING_STANDARDS.md`. Commit corrections with a
Conventional Commit subject and DCO sign-off.

Print the completed requirement matrix. Emit `<promise>COMPLETE</promise>` only
when every row is evidenced and all required gates are green. Do not assess
general coding style in this role; the independent standards reviewer owns that
axis.
