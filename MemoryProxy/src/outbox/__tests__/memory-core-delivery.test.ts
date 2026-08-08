import { describe, expect, it, vi } from "vitest";

import {
  MemoryCoreRoundDelivery,
  type L0RoundDelivery,
  type SkillRoundDelivery,
} from "../index.js";

const identity = {
  serviceId: "space-1",
  teamId: "team-1",
  userId: "user-1",
  agentId: "agent-1",
  taskId: "task-1",
  agentSource: "codex",
  sessionId: "session-1",
  turnId: "turn-1",
};

describe("MemoryCore completed-round delivery adapter", () => {
  it("delivers L0 with stable source identity and reconciles all batch receipts", async () => {
    const addConversation = vi.fn(async () => ({
      acceptedIds: ["message-1"],
      totalCount: 1,
      receipts: [
        {
          source_event_id: "round-1:l0:batch:0-of-1",
          content_hash: "batch-hash",
          status: "duplicate" as const,
          committed_at: "2026-08-08T00:00:00.000Z",
        },
      ],
    }));
    const adapter = new MemoryCoreRoundDelivery(
      { addConversation },
      { addConversation: vi.fn() },
      "space-1",
    );
    const input: L0RoundDelivery = {
      sourceEventId: "round-1:l0",
      contentHash: "sha256:l0",
      identity,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    };

    await expect(adapter.deliverL0(input)).resolves.toMatchObject({
      sourceEventId: "round-1:l0",
      contentHash: "sha256:l0",
      status: "duplicate",
    });
    expect(addConversation).toHaveBeenCalledWith(
      {
        teamId: "team-1",
        userId: "user-1",
        agentId: "agent-1",
        taskId: "task-1",
        sessionId: "session-1",
      },
      input.messages,
      { sourceEventId: "round-1:l0", contentHash: "sha256:l0" },
    );
  });

  it("delivers the normalized skill round with full isolation identity and verifies its receipt", async () => {
    const addConversation = vi.fn(async () => ({
      status: "ok" as const,
      receipt: {
        receipt_id: "skill-receipt-1",
        source_event_id: "round-1:skill",
        content_hash: "sha256:skill",
        accepted_at_ms: 1_000,
      },
    }));
    const adapter = new MemoryCoreRoundDelivery(
      { addConversation: vi.fn() },
      { addConversation },
      "space-1",
    );
    const input: SkillRoundDelivery = {
      sourceEventId: "round-1:skill",
      contentHash: "sha256:skill",
      identity,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    };

    await expect(adapter.deliverSkill(input)).resolves.toEqual({
      sourceEventId: "round-1:skill",
      contentHash: "sha256:skill",
      receiptId: "skill-receipt-1",
      status: "committed",
    });
    expect(addConversation).toHaveBeenCalledWith(
      {
        session_id: "session-1",
        space_id: "space-1",
        user_id: "user-1",
        team_id: "team-1",
        agent_id: "agent-1",
        task_id: "task-1",
        source_event_id: "round-1:skill",
        content_hash: "sha256:skill",
        messages: input.messages,
      },
      { serviceId: "space-1" },
    );
  });

  it("rejects a mismatched skill receipt so the outbox cannot mark the round committed", async () => {
    const adapter = new MemoryCoreRoundDelivery(
      { addConversation: vi.fn() },
      {
        addConversation: vi.fn(async () => ({
          status: "ok" as const,
          receipt: {
            receipt_id: "wrong",
            source_event_id: "another-event",
            content_hash: "sha256:skill",
            accepted_at_ms: 1_000,
          },
        })),
      },
      "space-1",
    );

    await expect(adapter.deliverSkill({
      sourceEventId: "round-1:skill",
      contentHash: "sha256:skill",
      identity,
      messages: [{ role: "user", content: "hello" }],
    })).rejects.toMatchObject({ retryable: true });
  });

  it("fails closed when the L0 client belongs to another service", async () => {
    const addConversation = vi.fn();
    const adapter = new MemoryCoreRoundDelivery(
      { addConversation },
      { addConversation: vi.fn() },
      "another-space",
    );

    await expect(adapter.deliverL0({
      sourceEventId: "round-1:l0",
      contentHash: "sha256:l0",
      identity,
      messages: [{ role: "user", content: "hello" }],
    })).rejects.toMatchObject({ retryable: false, safeKind: "l0_service_mismatch" });
    expect(addConversation).not.toHaveBeenCalled();
  });
});
