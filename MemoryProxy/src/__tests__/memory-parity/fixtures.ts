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

export const COMPLETED_ROUND_GOLDEN: NormalizedMessage[] = [
  { role: "user", content: USER_PROMPT },
  {
    role: "tool_call",
    content: JSON.stringify({ cmd: "printf 'xin chào'" }),
    tool_call_id: "tool-1",
    tool_name: "shell",
  },
  {
    role: "tool_result",
    content: "xin chào\nexit: 0",
    tool_call_id: "tool-1",
  },
  { role: "assistant", content: FINAL_ASSISTANT },
];

export const PROXY_ROUND_INPUTS: ProxyRoundInput[] = [
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
          { type: "text", text: USER_PROMPT },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden reasoning" },
          { type: "tool_use", id: "tool-1", name: "shell", input: { cmd: "printf 'xin chào'" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: [
              { type: "text", text: "xin chào\nexit: 0" },
              { type: "image", source: { type: "base64", data: "not-memory" } },
            ],
          },
        ],
      },
    ],
    assistantMessage: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "more hidden reasoning" },
        { type: "text", text: FINAL_ASSISTANT },
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
        content: `<user_info>generated context</user_info><user_query>${USER_PROMPT}</user_query>`,
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tool-1",
            type: "function",
            function: { name: "shell", arguments: JSON.stringify({ cmd: "printf 'xin chào'" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "tool-1", content: "xin chào\nexit: 0" },
    ],
    assistantMessage: { role: "assistant", content: FINAL_ASSISTANT },
  },
];

// This fixture is intentionally transport-neutral. A future Codex adapter can
// consume it without importing HTTP/proxy request shapes.
export const HOOK_ROUND_INPUT: HookRoundInput = {
  sessionStart: {
    event: "SessionStart",
    source: "startup",
    session_id: PARITY_IDENTITY.sessionId,
  },
  prompt: {
    event: "UserPromptSubmit",
    session_id: PARITY_IDENTITY.sessionId,
    turn_id: "turn-1",
    prompt: USER_PROMPT,
  },
  tools: [
    {
      event: "PostToolUse",
      session_id: PARITY_IDENTITY.sessionId,
      turn_id: "turn-1",
      tool_call_id: "tool-1",
      tool_name: "shell",
      input: { cmd: "printf 'xin chào'" },
      result: "xin chào\nexit: 0",
      failed: false,
    },
  ],
  stop: {
    event: "Stop",
    session_id: PARITY_IDENTITY.sessionId,
    turn_id: "turn-1",
    assistant: FINAL_ASSISTANT,
  },
};

export function normalizedHookRound(input: HookRoundInput): NormalizedMessage[] {
  return [
    { role: "user", content: input.prompt.prompt },
    ...input.tools.flatMap((tool) => [
      {
        role: "tool_call" as const,
        content: JSON.stringify(tool.input),
        tool_call_id: tool.tool_call_id,
        tool_name: tool.tool_name,
      },
      {
        role: "tool_result" as const,
        content: tool.result,
        tool_call_id: tool.tool_call_id,
      },
    ]),
    { role: "assistant", content: input.stop.assistant },
  ];
}
