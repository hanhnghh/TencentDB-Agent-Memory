import { describe, expect, it, vi } from "vitest";

import { resolveAgentAdapter } from "../agent-adapters/index.js";
import {
  createSessionNamespace,
  normalizeAgentSource,
} from "../agent-sources.js";
import { KvBindingRepo } from "../db/kv-binding-repo.js";
import { MemoryStorage } from "../storage/memory-storage.js";

describe("Codex agent source registry", () => {
  it("recognizes Codex without treating it as an unknown client", () => {
    expect(normalizeAgentSource("codex")).toBe("codex");
    expect(resolveAgentAdapter("codex").agentKind).toBe("codex");
  });

  it("isolates identical session identities for every client namespace", () => {
    const sessionId = "session-123";

    expect(new Set([
      createSessionNamespace("codex", sessionId),
      createSessionNamespace("claude-code", sessionId),
      createSessionNamespace("codebuddy", sessionId),
      createSessionNamespace("unknown", sessionId),
    ]).size).toBe(4);
    expect(createSessionNamespace("codex", sessionId)).toBe("codex:session-123");
  });

  it("rejects an empty session identity", () => {
    expect(() => createSessionNamespace("codex", "  ")).toThrow(
      "Codex session identity is required",
    );
  });

  it("recovers bindings only from the matching client namespace", async () => {
    const repo = new KvBindingRepo(new MemoryStorage());
    const sources = ["codex", "claude-code", "codebuddy", "unknown"];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await Promise.all(sources.map((source) => repo.putBinding(
      "memory-1",
      "user-1",
      source,
      "shared-session-id",
      {
        outcome: "initialized",
        teamId: "team-1",
        agentId: "agent-1",
        taskId: `task-${source}`,
      },
    )));

    for (const source of sources) {
      await expect(repo.getBinding(
        "memory-1",
        "user-1",
        source,
        "shared-session-id",
      )).resolves.toMatchObject({ taskId: `task-${source}` });
    }
    errorSpy.mockRestore();
  });
});
