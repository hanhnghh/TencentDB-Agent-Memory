import type { NormalizedMessage, Protocol } from "../../skill/normalize-conversation.js";
import type { AgentDetail, SessionInfo, TaskDetail } from "../../session/types.js";

export interface ProxyRoundInput {
  protocol: Protocol;
  agentSource: string;
  messages: Array<Record<string, unknown>>;
  assistantMessage: Record<string, unknown>;
}

export interface HookRoundInput {
  sessionStart: {
    event: "SessionStart";
    source: "startup" | "resume" | "clear" | "compact";
    session_id: string;
  };
  prompt: {
    event: "UserPromptSubmit";
    session_id: string;
    turn_id: string;
    prompt: string;
  };
  tools: Array<{
    event: "PostToolUse";
    session_id: string;
    turn_id: string;
    tool_call_id: string;
    tool_name: string;
    input: unknown;
    result: string;
    failed: boolean;
  }>;
  stop: {
    event: "Stop";
    session_id: string;
    turn_id: string;
    assistant: string;
  };
}

export interface NormalizationToolExchange {
  toolCallId: string;
  toolName: string;
  input: unknown;
  result: string;
  failed: boolean;
}

export interface NormalizationScenario {
  id:
    | "unicode-code"
    | "multiple-tools"
    | "failed-tool"
    | "empty-result"
    | "large-result-boundary";
  proxyInputs: ProxyRoundInput[];
  hookInput: HookRoundInput;
  golden: NormalizedMessage[];
}

export const PARITY_IDENTITY = {
  spaceId: "mem-space-a",
  userId: "user-a",
  agentSource: "claude-code",
  sessionId: "session-shared",
  teamId: "team-a",
  agentId: "agent-a",
  taskId: "task-a",
} as const;

export const OTHER_PARITY_IDENTITY = {
  ...PARITY_IDENTITY,
  spaceId: "mem-space-b",
  userId: "user-b",
  agentSource: "codebuddy",
  teamId: "team-b",
  agentId: "agent-b",
  taskId: "task-b",
} as const;

export const PARITY_SESSION_INFO: SessionInfo = {
  session_id: PARITY_IDENTITY.sessionId,
  space_id: PARITY_IDENTITY.spaceId,
  user_id: PARITY_IDENTITY.userId,
  team_id: PARITY_IDENTITY.teamId,
  agent_id: PARITY_IDENTITY.agentId,
  task_id: PARITY_IDENTITY.taskId,
  identity_verified: true,
  permissions: {
    user_in_team: true,
    user_in_task: true,
    agent_assigned_to_task: true,
    repo_in_team: true,
  },
};

export const PARITY_AGENT: AgentDetail = {
  id: PARITY_IDENTITY.agentId,
  name: "Parity Agent",
  description: "Keeps memory behavior stable.",
  prompt: "Preserve observable memory outcomes.",
};

export const PARITY_TASK: TaskDetail = {
  id: PARITY_IDENTITY.taskId,
  name: "Parity Task",
  description: "Characterize the current proxy.",
  goal: "Make proxy and hook outcomes comparable.",
};

export const USER_PROMPT = "Giữ Unicode 🧠 và code:\n```ts\nconst café = true;\n```";
export const INTERMEDIATE_ASSISTANT = "I will inspect the workspace.";
export const FINAL_ASSISTANT = "Done — the code block and Unicode are preserved.";

export const LARGE_TOOL_RESULT = "界".repeat(40 * 1024 + 1);

function createNormalizationScenario(input: {
  id: NormalizationScenario["id"];
  userPrompt: string;
  tools: NormalizationToolExchange[];
  assistant: string;
}): NormalizationScenario {
  const golden: NormalizedMessage[] = [
    { role: "user", content: input.userPrompt },
    ...input.tools.map((tool) => ({
      role: "tool_call" as const,
      content: JSON.stringify(tool.input),
      tool_call_id: tool.toolCallId,
      tool_name: tool.toolName,
    })),
    ...input.tools.map((tool) => ({
      role: "tool_result" as const,
      content: tool.result,
      tool_call_id: tool.toolCallId,
    })),
    { role: "assistant", content: input.assistant },
  ];
  const turnId = `turn-${input.id}`;

  return {
    id: input.id,
    golden,
    proxyInputs: [
      {
        protocol: "anthropic",
        agentSource: "claude-code",
        messages: [
          { role: "system", content: "secret system instruction" },
          {
            role: "user",
            content: [
              { type: "text", text: "<system-reminder>generated context</system-reminder>" },
              { type: "image", source: { type: "base64", data: "not-memory" } },
              { type: "text", text: input.userPrompt },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hidden reasoning" },
              ...input.tools.map((tool) => ({
                type: "tool_use",
                id: tool.toolCallId,
                name: tool.toolName,
                input: tool.input,
              })),
            ],
          },
          {
            role: "user",
            content: input.tools.map((tool) => ({
              type: "tool_result",
              tool_use_id: tool.toolCallId,
              is_error: tool.failed,
              content: [
                { type: "text", text: tool.result },
                { type: "image", source: { type: "base64", data: "not-memory" } },
              ],
            })),
          },
        ],
        assistantMessage: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "more hidden reasoning" },
            { type: "text", text: input.assistant },
            { type: "image", source: { type: "base64", data: "not-memory" } },
          ],
        },
      },
      {
        protocol: "openai",
        agentSource: "codebuddy",
        messages: [
          { role: "system", content: "secret system instruction" },
          {
            role: "user",
            content: `<user_info>generated context</user_info><user_query>${input.userPrompt}</user_query>`,
          },
          {
            role: "assistant",
            content: null,
            tool_calls: input.tools.map((tool) => ({
              id: tool.toolCallId,
              type: "function",
              function: {
                name: tool.toolName,
                arguments: JSON.stringify(tool.input),
              },
            })),
          },
          ...input.tools.map((tool) => ({
            role: "tool",
            tool_call_id: tool.toolCallId,
            content: tool.result,
          })),
        ],
        assistantMessage: { role: "assistant", content: input.assistant },
      },
    ],
    // Intentionally transport-neutral: the future Codex adapter can consume
    // every scenario without importing either proxy protocol shape.
    hookInput: {
      sessionStart: {
        event: "SessionStart",
        source: "startup",
        session_id: PARITY_IDENTITY.sessionId,
      },
      prompt: {
        event: "UserPromptSubmit",
        session_id: PARITY_IDENTITY.sessionId,
        turn_id: turnId,
        prompt: input.userPrompt,
      },
      tools: input.tools.map((tool) => ({
        event: "PostToolUse",
        session_id: PARITY_IDENTITY.sessionId,
        turn_id: turnId,
        tool_call_id: tool.toolCallId,
        tool_name: tool.toolName,
        input: tool.input,
        result: tool.result,
        failed: tool.failed,
      })),
      stop: {
        event: "Stop",
        session_id: PARITY_IDENTITY.sessionId,
        turn_id: turnId,
        assistant: input.assistant,
      },
    },
  };
}

export const NORMALIZATION_SCENARIOS: NormalizationScenario[] = [
  createNormalizationScenario({
    id: "unicode-code",
    userPrompt: USER_PROMPT,
    tools: [{
      toolCallId: "tool-1",
      toolName: "shell",
      input: { cmd: "printf 'xin chào'" },
      result: "xin chào\nexit: 0",
      failed: false,
    }],
    assistant: FINAL_ASSISTANT,
  }),
  createNormalizationScenario({
    id: "multiple-tools",
    userPrompt: "Inspect two files",
    tools: [
      {
        toolCallId: "tool-read-a",
        toolName: "read",
        input: { path: "a.ts" },
        result: "export const a = 1;",
        failed: false,
      },
      {
        toolCallId: "tool-read-b",
        toolName: "read",
        input: { path: "b.ts" },
        result: "export const b = 2;",
        failed: false,
      },
    ],
    assistant: "Both files were inspected.",
  }),
  createNormalizationScenario({
    id: "failed-tool",
    userPrompt: "Run the failing command",
    tools: [{
      toolCallId: "tool-failed",
      toolName: "shell",
      input: { cmd: "exit 17" },
      result: "command failed\nexit: 17",
      failed: true,
    }],
    assistant: "The command failed with exit code 17.",
  }),
  createNormalizationScenario({
    id: "empty-result",
    userPrompt: "Read the empty file",
    tools: [{
      toolCallId: "tool-empty",
      toolName: "read",
      input: { path: "empty.txt" },
      result: "",
      failed: false,
    }],
    assistant: "The file is empty.",
  }),
  createNormalizationScenario({
    id: "large-result-boundary",
    userPrompt: "Read the large generated payload",
    tools: [{
      toolCallId: "tool-large",
      toolName: "read",
      input: { path: "large.txt" },
      result: LARGE_TOOL_RESULT,
      failed: false,
    }],
    assistant: "The large payload was preserved.",
  }),
];

const unicodeScenario = NORMALIZATION_SCENARIOS[0];
export const COMPLETED_ROUND_GOLDEN = unicodeScenario.golden;
export const PROXY_ROUND_INPUTS = unicodeScenario.proxyInputs;
export const HOOK_ROUND_INPUT = unicodeScenario.hookInput;

export function normalizedHookRound(input: HookRoundInput): NormalizedMessage[] {
  return [
    { role: "user", content: input.prompt.prompt },
    ...input.tools.map((tool) => ({
      role: "tool_call" as const,
      content: JSON.stringify(tool.input),
      tool_call_id: tool.tool_call_id,
      tool_name: tool.tool_name,
    })),
    ...input.tools.map((tool) => ({
      role: "tool_result" as const,
      content: tool.result,
      tool_call_id: tool.tool_call_id,
    })),
    { role: "assistant", content: input.stop.assistant },
  ];
}
