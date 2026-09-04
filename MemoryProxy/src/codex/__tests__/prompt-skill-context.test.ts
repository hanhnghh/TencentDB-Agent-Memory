import { describe, expect, it, vi } from "vitest";

import { CorePromptSkillContext } from "../prompt-skill-context.js";
import type { CoreSkillClient } from "../../skill/core-client.js";

const identity = {
  serviceId: "memory-1",
  userId: "user-1",
  teamId: "team-1",
  agentId: "agent-1",
  taskId: "task-1",
  agentSource: "codex",
  sessionId: "session-1",
} as const;

const config = {
  endpoint: "http://127.0.0.1:8420",
  serviceToken: "local",
  serviceId: "context-proxy",
  timeoutMs: 1_500,
};

describe("CorePromptSkillContext", () => {
  it("searches within the bound identity and loads complete skill details", async () => {
    const searchSkills = vi.fn(async () => ({ items: [{
      skill_id: "skill-1",
      name: "vehicle-command-resolver",
      description: "Resolve vehicle commands",
      version: 2,
      score: 0.91,
    }] }));
    const getSkill = vi.fn(async () => ({
      skill_id: "skill-1",
      name: "vehicle-command-resolver",
      description: "Resolve vehicle commands",
      version: 2,
      content: "# Resolver\n\nFull authoritative workflow.",
    }));
    const context = new CorePromptSkillContext(config, {
      searchSkills,
      getSkill,
    } as Pick<CoreSkillClient, "searchSkills" | "getSkill">);

    const blocks = await context.recall({
      identity,
      prompt: "How are vehicle commands resolved?",
      limit: 3,
    });

    expect(searchSkills).toHaveBeenCalledWith({
      team_id: "team-1",
      agent_id: "agent-1",
      task_id: "task-1",
      query: "How are vehicle commands resolved?",
      top_k: 3,
      mode: "hybrid",
    }, { serviceId: "memory-1" });
    expect(getSkill).toHaveBeenCalledWith(expect.objectContaining({
      skill_id: "skill-1",
      include_content: true,
      include_manifest: false,
    }), { serviceId: "memory-1" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toContain("Full authoritative workflow.");
    expect(blocks[0]?.content).not.toContain("skill-bridge");
  });

  it("degrades to no skill context when search is unavailable", async () => {
    const context = new CorePromptSkillContext(config, {
      searchSkills: vi.fn(async () => { throw new Error("core unavailable"); }),
      getSkill: vi.fn(),
    } as unknown as Pick<CoreSkillClient, "searchSkills" | "getSkill">);

    await expect(context.recall({ identity, prompt: "question", limit: 3 })).resolves.toEqual([]);
  });
});
