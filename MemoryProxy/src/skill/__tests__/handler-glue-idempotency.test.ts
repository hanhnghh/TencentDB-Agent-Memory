import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../../config.js";
import { CoreSkillClient, setCoreSkillClient } from "../core-client.js";
import { triggerSkillExtractIfReady } from "../handler-glue.js";

afterEach(() => {
  setCoreSkillClient(null);
  vi.restoreAllMocks();
});

function makeInput(inputMessages: unknown[], assistantContent: string) {
  return {
    config: {
      ...DEFAULT_CONFIG,
      coreSkill: {
        endpoint: "https://core.example",
        serviceToken: "token",
        serviceId: "space-1",
        timeoutMs: 1_000,
      },
    },
    sessionKey: "session-1",
    agentSource: "codebuddy",
    sessionInfo: {
      space_id: "space-1",
      user_id: "user-1",
      team_id: "team-1",
      agent_id: "agent-1",
      task_id: "task-1",
    },
    inputMessages,
    assistantMessage: { role: "assistant", content: assistantContent },
    protocol: "openai" as const,
  };
}

function parseRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) {
    throw new Error("captured request body must be an object");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

describe("MemoryProxy skill ingestion identity", () => {
  it("sends a stable event ID and content hash for replay of one completed human turn", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher: typeof fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = parseRecord(String(init?.body));
      bodies.push(body);
      return new Response(JSON.stringify({
        code: 0,
        data: {
          status: "ok",
          receipt: {
            receipt_id: "receipt-1",
            source_event_id: body.source_event_id,
            content_hash: body.content_hash,
            accepted_at_ms: 42,
          },
        },
      }), { status: 200 });
    });
    setCoreSkillClient(new CoreSkillClient(DEFAULT_CONFIG.coreSkill, fetcher));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const input = makeInput([{ role: "user", content: "hello" }], "answer");
    await triggerSkillExtractIfReady(input);
    await triggerSkillExtractIfReady(input);

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      source_event_id: expect.stringMatching(/^proxy:/),
      content_hash: expect.stringMatching(/^sha256:/),
    });
    expect(bodies[1]?.source_event_id).toBe(bodies[0]?.source_event_id);
    expect(bodies[1]?.content_hash).toBe(bodies[0]?.content_hash);
  });

  it("keeps event identity stable but changes the hash when one turn's content changes", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher: typeof fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = parseRecord(String(init?.body));
      bodies.push(body);
      return new Response(JSON.stringify({
        code: 0,
        data: {
          status: "ok",
          receipt: {
            receipt_id: `receipt-${bodies.length}`,
            source_event_id: body.source_event_id,
            content_hash: body.content_hash,
            accepted_at_ms: 42,
          },
        },
      }), { status: 200 });
    });
    setCoreSkillClient(new CoreSkillClient(DEFAULT_CONFIG.coreSkill, fetcher));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await triggerSkillExtractIfReady(makeInput([{ role: "user", content: "hello" }], "answer one"));
    await triggerSkillExtractIfReady(makeInput([{ role: "user", content: "hello" }], "answer two"));

    expect(bodies[1]?.source_event_id).toBe(bodies[0]?.source_event_id);
    expect(bodies[1]?.content_hash).not.toBe(bodies[0]?.content_hash);
  });

  it("uses a different event ID for the next human turn in the same session", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher: typeof fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = parseRecord(String(init?.body));
      bodies.push(body);
      return new Response(JSON.stringify({
        code: 0,
        data: {
          status: "ok",
          receipt: {
            receipt_id: `receipt-${bodies.length}`,
            source_event_id: body.source_event_id,
            content_hash: body.content_hash,
            accepted_at_ms: 42,
          },
        },
      }), { status: 200 });
    });
    setCoreSkillClient(new CoreSkillClient(DEFAULT_CONFIG.coreSkill, fetcher));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await triggerSkillExtractIfReady(makeInput([{ role: "user", content: "first" }], "first answer"));
    await triggerSkillExtractIfReady(makeInput([
      { role: "user", content: "first" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second" },
    ], "second answer"));

    expect(bodies[1]?.source_event_id).not.toBe(bodies[0]?.source_event_id);
  });

  it("keeps event identity stable across compacted history for the same monotonic turn", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher: typeof fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = parseRecord(String(init?.body));
      bodies.push(body);
      return new Response(JSON.stringify({
        code: 0,
        data: {
          status: "ok",
          receipt: {
            receipt_id: "receipt-1",
            source_event_id: body.source_event_id,
            content_hash: body.content_hash,
            accepted_at_ms: 42,
          },
        },
      }), { status: 200 });
    });
    setCoreSkillClient(new CoreSkillClient(DEFAULT_CONFIG.coreSkill, fetcher));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await triggerSkillExtractIfReady({
      ...makeInput([
        { role: "user", content: "old turn" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "current turn" },
      ], "current answer"),
      turnSequence: 7,
    });
    await triggerSkillExtractIfReady({
      ...makeInput([{ role: "user", content: "current turn" }], "current answer"),
      turnSequence: 7,
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.source_event_id).toBe(bodies[0]?.source_event_id);
    expect(bodies[1]?.content_hash).toBe(bodies[0]?.content_hash);
  });

  it("carries the complete applicable identity tuple into source-event identity", async () => {
    const sourceEventIds: string[] = [];
    const fetcher: typeof fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = parseRecord(String(init?.body));
      const sourceEventId = body.source_event_id;
      if (typeof sourceEventId !== "string") throw new Error("missing source event identity");
      sourceEventIds.push(sourceEventId);
      return new Response(JSON.stringify({
        code: 0,
        data: {
          status: "ok",
          receipt: {
            receipt_id: `receipt-${sourceEventIds.length}`,
            source_event_id: sourceEventId,
            content_hash: body.content_hash,
            accepted_at_ms: 42,
          },
        },
      }), { status: 200 });
    });
    setCoreSkillClient(new CoreSkillClient(DEFAULT_CONFIG.coreSkill, fetcher));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const base = { ...makeInput([{ role: "user", content: "hello" }], "answer"), turnSequence: 7 };
    const variants = [
      base,
      { ...base, sessionKey: "session-2" },
      { ...base, agentSource: "claude-code" },
      { ...base, protocol: "anthropic" as const },
      { ...base, turnSequence: 8 },
      { ...base, sessionInfo: { ...base.sessionInfo, space_id: "space-2" } },
      { ...base, sessionInfo: { ...base.sessionInfo, user_id: "user-2" } },
      { ...base, sessionInfo: { ...base.sessionInfo, team_id: "team-2" } },
      { ...base, sessionInfo: { ...base.sessionInfo, agent_id: "agent-2" } },
      { ...base, sessionInfo: { ...base.sessionInfo, task_id: "task-2" } },
    ];

    for (const variant of variants) await triggerSkillExtractIfReady(variant);

    expect(sourceEventIds).toHaveLength(variants.length);
    expect(new Set(sourceEventIds).size).toBe(variants.length);
  });
});
