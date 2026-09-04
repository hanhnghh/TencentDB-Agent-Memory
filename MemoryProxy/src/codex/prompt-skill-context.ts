import { log } from "../report/log.js";
import type { BoundRuntimeIdentity, RuntimeContextBlock } from "../runtime/index.js";
import {
  getCoreSkillClient,
  type CoreSkillClient,
  type SkillDetail,
} from "../skill/core-client.js";
import type { CoreSkillConfig } from "../types.js";

export interface PromptSkillRecallInput {
  identity: BoundRuntimeIdentity;
  prompt: string;
  limit: number;
}

export interface PromptSkillContext {
  recall(input: PromptSkillRecallInput): Promise<RuntimeContextBlock[]>;
}

/** Retrieves complete prompt-relevant skills on the host side for Codex hooks. */
export class CorePromptSkillContext implements PromptSkillContext {
  constructor(
    private readonly config: CoreSkillConfig,
    private readonly client: Pick<CoreSkillClient, "searchSkills" | "getSkill"> =
      getCoreSkillClient(config),
  ) {}

  async recall(input: PromptSkillRecallInput): Promise<RuntimeContextBlock[]> {
    const limit = Math.max(1, Math.min(10, input.limit));
    try {
      const result = await this.client.searchSkills({
        team_id: input.identity.teamId,
        agent_id: input.identity.agentId,
        task_id: input.identity.taskId,
        query: input.prompt,
        top_k: limit,
        mode: "hybrid",
      }, { serviceId: input.identity.serviceId });
      const details = await Promise.allSettled(result.items.slice(0, limit).map((hit) => (
        this.client.getSkill({
          team_id: input.identity.teamId,
          agent_id: input.identity.agentId,
          task_id: input.identity.taskId,
          skill_id: hit.skill_id,
          include_content: true,
          include_manifest: false,
        }, { serviceId: input.identity.serviceId })
      )));
      return details.flatMap((detail, index) => {
        if (detail.status === "rejected") {
          log.warn("codex_hook.prompt_skill_detail_failed", {
            skillId: result.items[index]?.skill_id,
            errorType: detail.reason instanceof Error ? detail.reason.name : "unknown",
          });
          return [];
        }
        return [skillBlock(detail.value, index)];
      });
    } catch (cause: unknown) {
      log.warn("codex_hook.prompt_skill_recall_failed", {
        errorType: cause instanceof Error ? cause.name : "unknown",
      });
      return [];
    }
  }
}

function skillBlock(skill: SkillDetail, index: number): RuntimeContextBlock {
  return {
    id: `prompt-skill:${skill.skill_id}`,
    sourceHookId: "codex-prompt-skill-recall",
    kind: "skill",
    order: 200 + index,
    type: "text",
    content: [
      `# Loaded Agent Memory Skill: ${skill.name}`,
      "The sidecar selected this skill for the current prompt. Follow its instructions when relevant.",
      "",
      skill.content,
    ].join("\n"),
  };
}
