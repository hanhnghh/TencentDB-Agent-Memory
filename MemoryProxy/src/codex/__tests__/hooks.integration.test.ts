import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { createHookApp } from "../../hook-server.js";
import {
  InMemoryMemoryRuntimeAdapters,
  MemoryRuntime,
  MemoryRuntimeAuthorizationError,
  type MemoryRuntimeContract,
} from "../../runtime/index.js";
import type { MemoryRuntimeProvider } from "../../runtime/production.js";
import type { ProxyConfig } from "../../types.js";
import {
  CodexHookBindingError,
  type CodexHookAccess,
  type CodexHookAccessResolver,
} from "../hook-access.js";
import type { CodexTurnStore } from "../turn-store.js";

const identity = {
  serviceId: "memory-1",
  userId: "user-1",
  teamId: "team-1",
  agentId: "agent-1",
  taskId: "task-1",
  agentSource: "codex",
  sessionId: "session-1",
} as const;

const access: CodexHookAccess = {
  identity,
  bindingCacheKey: "memory-runtime:full-binding-key",
  userKey: "user-key-secret",
  preferences: { dynamicRecall: true, contextLimit: 3 },
};

function config(): ProxyConfig {
  const value: ProxyConfig = structuredClone(DEFAULT_CONFIG);
  value.runtime.mode = "hooks";
  value.upstream.url = "";
  return value;
}

function resolver(result: CodexHookAccess = access): CodexHookAccessResolver {
  return { resolve: vi.fn(async () => structuredClone(result)) };
}

function turnStore(): CodexTurnStore {
  return {
    beginTurn: vi.fn(async () => ({ status: "persisted" as const })),
    close: vi.fn(),
  };
}

function runtimeWithContext(): MemoryRuntime {
  return new MemoryRuntime(new InMemoryMemoryRuntimeAdapters({
    binding: {
      identity,
      resolution: "cached",
      agent: {
        id: "agent-1",
        name: "Memory Agent",
        description: "Keeps decisions. token=agent-secret",
      },
      task: {
        id: "task-1",
        name: "Hook parity",
        description: "Restore durable context.",
      },
    },
    context: {
      blocks: [
        {
          id: "memory-1",
          sourceHookId: "tdai-profile-memory-injector",
          kind: "memory",
          order: 100,
          type: "text",
          content: "Remember the release decision. {\"api_key\":\"json-secret\"} Authorization: Basic dXNlcjpwYXNz",
        },
        {
          id: "skill-1",
          sourceHookId: "skill-injector",
          kind: "skill",
          order: 200,
          type: "text",
          content: "Use the deploy checklist.",
        },
        {
          id: "knowledge-1",
          sourceHookId: "knowledge-tools-injector",
          kind: "knowledge",
          order: 300,
          type: "text",
          content: "Architecture lives in docs/architecture.md.",
        },
      ],
      diagnostics: { prewarmed: ["memory", "skill"], cacheHits: [], degraded: [] },
    },
  }));
}

function provider(runtime: MemoryRuntimeContract): MemoryRuntimeProvider {
  return { forRequest: vi.fn(() => runtime) };
}

function sessionStart(source: "startup" | "resume" | "clear" | "compact") {
  return {
    cwd: "/workspace/project",
    hook_event_name: "SessionStart",
    model: "gpt-5",
    permission_mode: "default",
    session_id: "session-1",
    source,
    transcript_path: "/private/transcript.jsonl",
  };
}

async function readHookContext(response: Response): Promise<{
  suppressOutput: true;
  hookEventName: string;
  additionalContext: string;
}> {
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("hook response must be an object");
  }
  const suppressOutput = Reflect.get(body, "suppressOutput");
  const specific = Reflect.get(body, "hookSpecificOutput");
  if (suppressOutput !== true || !specific || typeof specific !== "object" || Array.isArray(specific)) {
    throw new TypeError("hook response is missing hookSpecificOutput");
  }
  const hookEventName = Reflect.get(specific, "hookEventName");
  const additionalContext = Reflect.get(specific, "additionalContext");
  if (typeof hookEventName !== "string" || typeof additionalContext !== "string") {
    throw new TypeError("hook response context is invalid");
  }
  return { suppressOutput, hookEventName, additionalContext };
}

describe("Codex lifecycle hook contract", () => {
  it("rejects undocumented hook fields at the HTTP boundary", async () => {
    const app = createHookApp(config(), {
      memoryRuntimeProvider: provider(runtimeWithContext()),
      codexAccessResolver: resolver(),
      codexTurnStore: turnStore(),
    });

    const response = await app.request("/hooks/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...sessionStart("startup"), caller_user_key: "must-not-pass" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_session_start" });
  });

  it.each(["startup", "resume", "clear", "compact"] as const)(
    "injects ordered, delimited context for SessionStart source %s",
    async (source) => {
      const app = createHookApp(config(), {
        memoryRuntimeProvider: provider(runtimeWithContext()),
        codexAccessResolver: resolver(),
        codexTurnStore: turnStore(),
      });

      const response = await app.request("/hooks/session-start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sessionStart(source)),
      });

      expect(response.status).toBe(200);
      const output = await readHookContext(response);
      expect(output).toMatchObject({
        suppressOutput: true,
        hookEventName: "SessionStart",
      });
      const context = output.additionalContext;
      expect(context).toContain("<agent_memory_context");
      expect(context).toContain('capture="exclude"');
      expect(context.indexOf("Memory Agent")).toBeLessThan(context.indexOf("Remember the release decision."));
      expect(context.indexOf("Remember the release decision.")).toBeLessThan(context.indexOf("Use the deploy checklist."));
      expect(context.indexOf("Use the deploy checklist.")).toBeLessThan(context.indexOf("Architecture lives in docs/architecture.md."));
      expect(context).not.toContain("agent-secret");
      expect(context).not.toContain("json-secret");
      expect(context).not.toContain("dXNlcjpwYXNz");
      expect(context).not.toContain("transcript.jsonl");
    },
  );

  it("persists the exact real prompt before returning bounded prompt recall", async () => {
    const prepareContext = vi.fn<MemoryRuntimeContract["prepareContext"]>(async () => ({
      session: {
        identity,
        agent: { id: "agent-1", name: "Agent" },
        task: { id: "task-1", name: "Task" },
      },
      blocks: [
        {
          id: "prompt-recall",
          sourceHookId: "tdai-l1-recall-injector",
          kind: "memory",
          order: 150,
          type: "text",
          content: "Prompt-relevant memory.",
        },
        {
          id: "static-session-memory",
          sourceHookId: "tdai-profile-memory-injector",
          kind: "memory",
          order: 100,
          type: "text",
          content: "Do not repeat static session context.",
        },
      ],
      capabilities: {
        memory: { enabled: true },
        skill: { enabled: true },
        knowledge: { wiki: { enabled: true }, codeGraph: { enabled: true } },
      },
      diagnostics: { binding: "cached", prewarmed: [], cacheHits: [], degraded: [] },
    }));
    const runtime: MemoryRuntimeContract = {
      prepareContext,
      commitCompletedRound: vi.fn(),
    };
    const store = turnStore();
    const memoryRuntimeProvider = provider(runtime);
    const app = createHookApp(config(), {
      memoryRuntimeProvider,
      codexAccessResolver: resolver(),
      codexTurnStore: store,
    });
    const prompt = "Keep this `code block` unchanged. user_key=prompt-secret";

    const response = await app.request("/hooks/user-prompt-submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd: "/workspace/project",
        hook_event_name: "UserPromptSubmit",
        model: "gpt-5",
        permission_mode: "default",
        session_id: "session-1",
        transcript_path: null,
        turn_id: "turn-7",
        prompt,
      }),
    });

    expect(response.status).toBe(200);
    expect(store.beginTurn).toHaveBeenCalledWith({
      identity: { ...identity, turnId: "turn-7" },
      prompt,
    });
    expect(memoryRuntimeProvider.forRequest).toHaveBeenCalledWith({
      userKey: access.userKey,
      bindingCacheKey: access.bindingCacheKey,
    });
    expect(prepareContext).toHaveBeenCalledWith({
      identity,
      query: prompt,
      readOnly: false,
    });
    const output = await readHookContext(response);
    expect(output.hookEventName).toBe("UserPromptSubmit");
    expect(output.additionalContext).toContain("Prompt-relevant memory.");
    expect(output.additionalContext).not.toContain("static session context");
    expect(output.additionalContext).not.toContain(prompt);
    expect(output).not.toHaveProperty("modifiedPrompt");
  });

  it("selects complete context blocks deterministically at the configured limit", async () => {
    const limitedAccess: CodexHookAccess = {
      ...access,
      preferences: { contextLimit: 1 },
    };
    const app = createHookApp(config(), {
      memoryRuntimeProvider: provider(runtimeWithContext()),
      codexAccessResolver: resolver(limitedAccess),
      codexTurnStore: turnStore(),
    });

    const response = await app.request("/hooks/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sessionStart("compact")),
    });

    const output = await readHookContext(response);
    const context = output.additionalContext;
    expect(context).toContain("Remember the release decision.");
    expect(context).not.toContain("Use the deploy checklist.");
    expect(context).not.toContain("Architecture lives in docs/architecture.md.");
    expect(context).toContain("2 context block(s) omitted by deterministic limits");
    expect(context).not.toMatch(/Remember the release decisio\n/);
  });

  it("omits an oversized block as a whole while retaining later bounded context", async () => {
    const runtime: MemoryRuntimeContract = {
      prepareContext: async () => ({
        session: {
          identity,
          agent: { id: "agent-1", name: "Agent" },
          task: { id: "task-1", name: "Task" },
        },
        blocks: [
          {
            id: "oversized",
            sourceHookId: "tdai-profile-memory-injector",
            kind: "memory",
            order: 100,
            type: "text",
            content: `OVERSIZED:${"x".repeat(6_000)}`,
          },
          {
            id: "bounded",
            sourceHookId: "skill-injector",
            kind: "skill",
            order: 200,
            type: "text",
            content: "Complete bounded block.",
          },
        ],
        capabilities: {
          memory: { enabled: true },
          skill: { enabled: true },
          knowledge: { wiki: { enabled: true }, codeGraph: { enabled: true } },
        },
        diagnostics: { binding: "cached", prewarmed: [], cacheHits: [], degraded: [] },
      }),
      commitCompletedRound: vi.fn(),
    };
    const app = createHookApp(config(), {
      memoryRuntimeProvider: provider(runtime),
      codexAccessResolver: resolver({ ...access, preferences: {} }),
      codexTurnStore: turnStore(),
    });

    const response = await app.request("/hooks/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sessionStart("startup")),
    });
    const output = await readHookContext(response);

    expect(output.additionalContext.length).toBeLessThanOrEqual(5_000);
    expect(output.additionalContext).not.toContain("OVERSIZED:");
    expect(output.additionalContext).toContain("Complete bounded block.");
  });

  it("keeps prompt recall within the final Codex host budget without partial blocks", async () => {
    const runtime: MemoryRuntimeContract = {
      prepareContext: async () => ({
        session: {
          identity,
          agent: { id: "agent-1", name: "Agent" },
          task: { id: "task-1", name: "Task" },
        },
        blocks: [
          {
            id: "oversized-prompt-recall",
            sourceHookId: "tdai-l1-recall-injector",
            kind: "memory",
            order: 100,
            type: "text",
            content: `OVERSIZED_PROMPT:${"y".repeat(3_000)}`,
          },
          {
            id: "bounded-prompt-recall",
            sourceHookId: "tdai-l1-recall-injector",
            kind: "memory",
            order: 200,
            type: "text",
            content: "Complete prompt recall block.",
          },
        ],
        capabilities: {
          memory: { enabled: true },
          skill: { enabled: true },
          knowledge: { wiki: { enabled: true }, codeGraph: { enabled: true } },
        },
        diagnostics: { binding: "cached", prewarmed: [], cacheHits: [], degraded: [] },
      }),
      commitCompletedRound: vi.fn(),
    };
    const app = createHookApp(config(), {
      memoryRuntimeProvider: provider(runtime),
      codexAccessResolver: resolver(),
      codexTurnStore: turnStore(),
    });

    const response = await app.request("/hooks/user-prompt-submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd: "/workspace/project",
        hook_event_name: "UserPromptSubmit",
        model: "gpt-5",
        permission_mode: "default",
        session_id: "session-1",
        transcript_path: null,
        turn_id: "turn-bounded",
        prompt: "real prompt",
      }),
    });
    const output = await readHookContext(response);

    expect(output.additionalContext.length).toBeLessThanOrEqual(2_500);
    expect(output.additionalContext).not.toContain("OVERSIZED_PROMPT:");
    expect(output.additionalContext).toContain("Complete prompt recall block.");
  });

  it("does not acknowledge UserPromptSubmit when durable prompt persistence fails", async () => {
    const runtime = runtimeWithContext();
    const store = turnStore();
    vi.mocked(store.beginTurn).mockRejectedValueOnce(new Error("disk full"));
    const app = createHookApp(config(), {
      memoryRuntimeProvider: provider(runtime),
      codexAccessResolver: resolver(),
      codexTurnStore: store,
    });

    const response = await app.request("/hooks/user-prompt-submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd: "/workspace/project",
        hook_event_name: "UserPromptSubmit",
        model: "gpt-5",
        permission_mode: "default",
        session_id: "session-1",
        transcript_path: null,
        turn_id: "turn-8",
        prompt: "real prompt",
      }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "prompt_persistence_failed" });
  });

  it("fails closed without leaking context when runtime ACL denies the read", async () => {
    const runtime: MemoryRuntimeContract = {
      prepareContext: async () => {
        throw new MemoryRuntimeAuthorizationError("read", "team_scope_denied");
      },
      commitCompletedRound: vi.fn(),
    };
    const app = createHookApp(config(), {
      memoryRuntimeProvider: provider(runtime),
      codexAccessResolver: resolver(),
      codexTurnStore: turnStore(),
    });

    const response = await app.request("/hooks/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sessionStart("startup")),
    });

    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain("team_scope_denied");
  });

  it("classifies a missing project binding without reading a transcript fallback", async () => {
    const accessResolver: CodexHookAccessResolver = {
      resolve: vi.fn(async () => {
        throw new CodexHookBindingError("missing_binding");
      }),
    };
    const app = createHookApp(config(), {
      memoryRuntimeProvider: provider(runtimeWithContext()),
      codexAccessResolver: accessResolver,
      codexTurnStore: turnStore(),
    });

    const response = await app.request("/hooks/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sessionStart("resume")),
    });

    expect(response.status).toBe(412);
    await expect(response.json()).resolves.toMatchObject({ error: "missing_binding" });
    expect(accessResolver.resolve).toHaveBeenCalledWith({
      cwd: "/workspace/project",
      sessionId: "session-1",
    });
  });
});
