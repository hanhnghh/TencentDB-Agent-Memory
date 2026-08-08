# Task

Merge these reviewed branches into the current branch:

{{BRANCHES}}

Issue mapping:

{{ISSUES}}

# Verified merge loop

Process one branch at a time:

1. Confirm the branch maps to exactly one listed GitHub Issue.
2. Merge with `git merge --no-ff --no-edit <branch>`.
3. Resolve conflicts by re-reading both issue contracts and preserving the combined intended behavior.
4. Identify every package changed by the cumulative merge.
5. Run its focused regression tests, then every authoritative module-local gate required by `.sandcastle/CODING_STANDARDS.md`.
6. If a gate turns red, fix the integration defect and rerun the failing check and affected package gate until green.
7. Close the mapped issue only after the branch is present in `HEAD` and its cumulative gate is green:

```bash
gh issue close <number> --comment "Implemented, reviewed, and verified by Sandcastle."
```

Keep an issue open when its branch cannot be merged or verified. Add a concise issue comment with the conflict or failing command so a later round has durable context.

# Completion gate

After all possible branches are processed, rerun the authoritative gates for the cumulative changed surface. Emit `<promise>COMPLETE</promise>` only when every closed issue is merged and the final cumulative gate is green. Never close an issue based only on agent exit status or the existence of commits.
