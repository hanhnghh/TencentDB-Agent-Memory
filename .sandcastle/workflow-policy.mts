export interface ReviewEligibility {
  branchAheadBase: boolean;
  implementCommitCount: number;
}

export interface IssueRunEvidence {
  branchAheadBase: boolean;
  specReviewComplete: boolean;
  standardsReviewComplete: boolean;
  newCommitCount: number;
}

export type IssueRunDisposition = "merge" | "retry" | "stop";

/**
 * Resume-safe review eligibility.
 *
 * Sandcastle reports only commits created by the current agent invocation.
 * A resumed branch may already be ahead of base while the implementer creates
 * zero new commits, so current-run commit count cannot be the sole review gate.
 */
export function shouldReviewBranch(input: ReviewEligibility): boolean {
  return input.branchAheadBase || input.implementCommitCount > 0;
}

/**
 * Decide whether an issue can merge, should receive another outer-loop pass,
 * or has made no progress and should stop the AFK run.
 */
export function classifyIssueRun(input: IssueRunEvidence): IssueRunDisposition {
  if (
    input.branchAheadBase
    && input.specReviewComplete
    && input.standardsReviewComplete
  ) {
    return "merge";
  }
  if (input.newCommitCount > 0) return "retry";
  return "stop";
}
