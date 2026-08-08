// GitHub Issues planner with implementation, review, and verified merge phases.
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):             A Codex agent queries GitHub Issues, builds a
//                               dependency graph, and outputs a <plan> JSON
//                               listing unblocked issues with branch names.
//   Phase 2 (Execute + Review): For each issue, a sandbox is created via
//                               createSandbox(). The implementer runs first
//                               (up to 12 iterations). Any branch ahead of base
//                               then receives independent specification and
//                               standards reviews. This repository deliberately
//                               runs one issue at a time while its shared memory
//                               contracts are being established.
//   Phase 3 (Merge):            A single agent merges all completed branches
//                               into the current branch.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { z } from "zod";
import {
  classifyIssueRun,
  shouldReviewBranch,
  type IssueRunDisposition,
} from "./workflow-policy.mts";

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const plannedIssueSchema = z.object({
  id: z.string().regex(/^\d+$/),
  title: z.string().min(1),
  branch: z.string().regex(/^sandcastle\/issue-\d+$/),
});

type PlannedIssue = z.infer<typeof plannedIssueSchema>;

const MAX_PARALLEL_ISSUES = 1;

const planSchema = z.object({
  issues: z.array(plannedIssueSchema).max(MAX_PARALLEL_ISSUES),
}).superRefine((plan, context) => {
  const seenIds = new Set<string>();

  plan.issues.forEach((issue, index) => {
    if (seenIds.has(issue.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate issue ${issue.id}`,
        path: ["issues", index, "id"],
      });
    }
    seenIds.add(issue.id);

    if (issue.branch !== `sandcastle/issue-${issue.id}`) {
      context.addIssue({
        code: "custom",
        message: `Branch must match issue ${issue.id}`,
        path: ["issues", index, "branch"],
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;
const BASE_BRANCH = execFileSync("git", ["branch", "--show-current"], {
  encoding: "utf8",
}).trim();

if (!BASE_BRANCH) {
  throw new Error("Sandcastle requires a named Git branch, not detached HEAD.");
}

function branchIsAheadBase(branch: string): boolean {
  const count = execFileSync(
    "git",
    ["rev-list", "--count", `${BASE_BRANCH}..${branch}`],
    { encoding: "utf8" },
  ).trim();
  return Number.parseInt(count, 10) > 0;
}

// Fail fast when either subscription authentication or GitHub authentication
// is unavailable. Product dependencies are installed package-by-package by the
// agent because this repository has no single root product workspace.
const hooks = {
  sandbox: {
    onSandboxReady: [
      { command: "test -f /home/agent/CODING_STANDARDS.md" },
      { command: "codex login status" },
      { command: "gh auth status" },
    ],
  },
};

// Keep Sandcastle's ChatGPT subscription session separate from the host's
// normal Codex home. The mounted directory is writable so Codex can refresh
// OAuth tokens. It is ignored by Git because auth.json is a credential.
const CODEX_HOME_HOST = ".sandcastle/codex-home";
const CODEX_HOME_SANDBOX = "/home/agent/.codex";
const CODEX_CONFIG_HOST = `${CODEX_HOME_HOST}/config.toml`;
const STANDARDS_HOST = ".sandcastle/CODING_STANDARDS.md";
const STANDARDS_SANDBOX = "/home/agent/CODING_STANDARDS.md";
const PROXY_TYPE_GATE_HOST =
  ".sandcastle/scripts/check-memory-proxy-types.sh";
const PROXY_TYPE_GATE_SANDBOX =
  "/home/agent/check-memory-proxy-types.sh";
const CACHE_MOUNTS = [
  {
    hostPath: ".sandcastle/cache/npm",
    sandboxPath: "/home/agent/.npm",
  },
  {
    hostPath: ".sandcastle/cache/pnpm-store",
    sandboxPath: "/home/agent/.local/share/pnpm/store",
  },
  {
    hostPath: ".sandcastle/cache/pip",
    sandboxPath: "/home/agent/.cache/pip",
  },
] as const;

mkdirSync(CODEX_HOME_HOST, { recursive: true, mode: 0o700 });
chmodSync(CODEX_HOME_HOST, 0o700);
for (const cache of CACHE_MOUNTS) {
  mkdirSync(cache.hostPath, { recursive: true });
}
if (!existsSync(CODEX_CONFIG_HOST)) {
  writeFileSync(
    CODEX_CONFIG_HOST,
    [
      'cli_auth_credentials_store = "file"',
      'forced_login_method = "chatgpt"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}
chmodSync(CODEX_CONFIG_HOST, 0o600);

const codexSandbox = () =>
  docker({
    mounts: [
      {
        hostPath: CODEX_HOME_HOST,
        sandboxPath: CODEX_HOME_SANDBOX,
      },
      {
        hostPath: STANDARDS_HOST,
        sandboxPath: STANDARDS_SANDBOX,
        readonly: true,
      },
      {
        hostPath: PROXY_TYPE_GATE_HOST,
        sandboxPath: PROXY_TYPE_GATE_SANDBOX,
        readonly: true,
      },
      ...CACHE_MOUNTS,
    ],
    env: {
      HOME: "/home/agent",
      CODEX_HOME: CODEX_HOME_SANDBOX,
    },
  });

type CodexEffort = "low" | "medium" | "high" | "xhigh";

const codexAgent = (effort: CodexEffort = "high") =>
  sandcastle.codex("gpt-5.6-sol", {
    effort,
    sessionStorage: {
      hostSessionsDir: `${CODEX_HOME_HOST}/sessions`,
      sandboxSessionsDir: `${CODEX_HOME_SANDBOX}/sessions`,
    },
  });

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent queries the open GitHub issue list itself,
  // builds a dependency graph, and selects the issues that can be worked in
  // parallel right now (i.e., no blocking dependencies on other open issues).
  //
  // It outputs a <plan> JSON block — Output.object parses and validates it.
  // -------------------------------------------------------------------------
  const plan = await sandcastle.run({
    hooks,
    sandbox: codexSandbox(),
    name: "planner",
    // One iteration is enough: the planner just needs to read and reason,
    // not write code. (Structured output requires maxIterations: 1.)
    maxIterations: 1,
    agent: codexAgent("medium"),
    promptFile: "./.sandcastle/plan-prompt.md",
    // Extract and validate the <plan> JSON into a typed object. Throws
    // StructuredOutputError if the tag is missing, the JSON is malformed, or
    // validation fails — which aborts the loop.
    output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
  });

  const issues: PlannedIssue[] = plan.output.issues;

  if (issues.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    console.log("No unblocked issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute + Review
  //
  // For each issue, create a sandbox via createSandbox() so the implementer
  // and independent reviewers share the same sandbox instance per branch.
  // Existing ahead-of-base branches are reviewed even when the resumed
  // implementer creates no new commit.
  //
  // Promise.allSettled means one failing pipeline doesn't cancel the others.
  // -------------------------------------------------------------------------

  const settled = await Promise.allSettled(
    issues.map(async (issue) => {
      const sandbox = await sandcastle.createSandbox({
        branch: issue.branch,
        sandbox: codexSandbox(),
        hooks,
      });

      try {
        // Run the implementer
        const implement = await sandbox.run({
          name: "implementer",
          maxIterations: 12,
          agent: codexAgent(),
          promptFile: "./.sandcastle/implement-prompt.md",
          promptArgs: {
            TASK_ID: issue.id,
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
          },
        });

        const branchAheadAfterImplement = branchIsAheadBase(issue.branch);
        if (shouldReviewBranch({
          branchAheadBase: branchAheadAfterImplement,
          implementCommitCount: implement.commits.length,
        })) {
          const specReview = await sandbox.run({
            name: "spec-reviewer",
            maxIterations: 3,
            agent: codexAgent("high"),
            promptFile: "./.sandcastle/spec-review-prompt.md",
            promptArgs: {
              BRANCH: issue.branch,
              TASK_ID: issue.id,
              ISSUE_TITLE: issue.title,
              BASE_BRANCH,
            },
          });
          const standardsReview = await sandbox.run({
            name: "standards-reviewer",
            maxIterations: 2,
            agent: codexAgent("high"),
            promptFile: "./.sandcastle/standards-review-prompt.md",
            promptArgs: {
              BRANCH: issue.branch,
              TASK_ID: issue.id,
              ISSUE_TITLE: issue.title,
              BASE_BRANCH,
            },
          });
          const commits = [
            ...implement.commits,
            ...specReview.commits,
            ...standardsReview.commits,
          ];
          const branchAheadBase = branchIsAheadBase(issue.branch);
          const disposition = classifyIssueRun({
            branchAheadBase,
            specReviewComplete: specReview.completionSignal !== undefined,
            standardsReviewComplete:
              standardsReview.completionSignal !== undefined,
            newCommitCount: commits.length,
          });
          return {
            commits,
            branchAheadBase,
            disposition,
          };
        }

        const disposition: IssueRunDisposition = classifyIssueRun({
          branchAheadBase: branchAheadAfterImplement,
          specReviewComplete: false,
          standardsReviewComplete: false,
          newCommitCount: implement.commits.length,
        });
        return {
          commits: implement.commits,
          branchAheadBase: branchAheadAfterImplement,
          disposition,
        };
      } finally {
        await sandbox.close();
      }
    }),
  );

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
      );
    }
  }

  // Merge requires an existing branch diff plus independent green spec and
  // standards gates. Current-run commit count is intentionally not required:
  // resumed branches may already contain all implementation commits.
  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (entry) =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.disposition === "merge" &&
        entry.outcome.value.branchAheadBase,
    )
    .map((entry) => entry.issue);

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    const madeRetryableProgress = settled.some(
      (outcome) =>
        outcome.status === "fulfilled"
        && outcome.value.disposition === "retry",
    );
    if (madeRetryableProgress) {
      console.log("Review corrections were committed; planning another iteration.");
      continue;
    }
    console.log("No reviewed branch passed its feedback gate.");
    break;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Merge
  //
  // One agent merges all completed branches into the current branch,
  // resolving any conflicts and running tests to confirm everything works.
  //
  // The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
  // uses to know which branches to merge and which issues to close.
  // -------------------------------------------------------------------------
  const merge = await sandcastle.run({
    hooks,
    sandbox: codexSandbox(),
    name: "merger",
    maxIterations: 3,
    agent: codexAgent(),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      // A markdown list of branch names, one per line.
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      // A markdown list of issue IDs and titles, one per line.
      ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
    },
  });

  if (merge.completionSignal === undefined) {
    console.error("\nMerge feedback gate did not complete; stopping the run.");
    break;
  }

  console.log("\nBranches merged and cumulatively verified.");
}

console.log("\nAll done.");
