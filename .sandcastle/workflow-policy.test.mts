import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyIssueRun,
  shouldReviewBranch,
} from "./workflow-policy.mts";

describe("Sandcastle resume and review policy", () => {
  it("reviews a resumed branch that is ahead of base without new implementer commits", () => {
    assert.equal(shouldReviewBranch({ branchAheadBase: true, implementCommitCount: 0 }), true);
  });

  it("does not review a branch with neither existing nor new commits", () => {
    assert.equal(shouldReviewBranch({ branchAheadBase: false, implementCommitCount: 0 }), false);
  });

  it("merges only after independent spec and standards gates complete", () => {
    assert.equal(classifyIssueRun({
      branchAheadBase: true,
      specReviewComplete: true,
      standardsReviewComplete: true,
      newCommitCount: 0,
    }), "merge");
    assert.equal(classifyIssueRun({
      branchAheadBase: true,
      specReviewComplete: true,
      standardsReviewComplete: false,
      newCommitCount: 0,
    }), "stop");
  });

  it("retries after a reviewer correction instead of ending the outer loop", () => {
    assert.equal(classifyIssueRun({
      branchAheadBase: true,
      specReviewComplete: false,
      standardsReviewComplete: false,
      newCommitCount: 1,
    }), "retry");
  });

  it("cannot merge a completion signal from a branch with no commits ahead of base", () => {
    assert.equal(classifyIssueRun({
      branchAheadBase: false,
      specReviewComplete: true,
      standardsReviewComplete: true,
      newCommitCount: 0,
    }), "stop");
  });
});
