import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexManagementError,
  executeCodexManagement,
} from "../management-client.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("Codex management client", () => {
  it("sends exact local skill content with server-bound session headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-management-"));
    temporaryRoots.push(root);
    const contentFile = join(root, "SKILL.md");
    await writeFile(contentFile, "# Migration skill\n\nUse the checklist.\n", "utf8");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ code: 0, data: { skill_id: "skill-1" } }), {
        headers: { "content-type": "application/json" },
      });
    };

    await expect(executeCodexManagement({
      operation: "create-skill",
      sessionId: "session-1",
      sidecarUrl: "http://127.0.0.1:8097",
      name: "migration-checklist",
      contentFile,
    }, fetcher)).resolves.toMatchObject({
      message: "Agent Memory skill created.",
      data: { skill_id: "skill-1" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8097/skill-bridge/v3/skill/create");
    expect(calls[0]?.init?.headers).toMatchObject({
      "x-agent-source": "codex",
      "x-conversation-id": "session-1",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "migration-checklist",
      content: "# Migration skill\n\nUse the checklist.\n",
    });
  });

  it("rejects a non-loopback sidecar before making a request", async () => {
    let called = false;
    const fetcher: typeof fetch = async () => {
      called = true;
      return new Response(JSON.stringify({ code: 0 }));
    };

    await expect(executeCodexManagement({
      operation: "refresh",
      sessionId: "session-1",
      sidecarUrl: "https://public.example",
    }, fetcher)).rejects.toThrow("loopback HTTP URL");
    expect(called).toBe(false);
  });

  it.each([
    {
      label: "timeout",
      fetcher: async () => { throw new DOMException("timed out", "TimeoutError"); },
      kind: "timeout",
    },
    {
      label: "network failure",
      fetcher: async () => { throw new TypeError("connection refused"); },
      kind: "network",
    },
  ] as const)("classifies a $label without exposing dependency details", async ({ fetcher, kind }) => {
    let error: unknown;
    try {
      await executeCodexManagement({
        operation: "refresh",
        sessionId: "session-1",
        sidecarUrl: "http://127.0.0.1:8097",
      }, fetcher);
    } catch (cause: unknown) {
      error = cause;
    }

    expect(error).toBeInstanceOf(CodexManagementError);
    if (!(error instanceof CodexManagementError)) throw new TypeError("expected typed error");
    expect(error.kind).toBe(kind);
    expect(error.message).not.toContain("connection refused");
  });

  it.each([
    { status: 429, kind: "throttled" },
    { status: 503, kind: "server" },
    { status: 403, kind: "client" },
  ] as const)("classifies HTTP $status as $kind", async ({ status, kind }) => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      code: status,
      message: "dependency detail",
    }), { status, headers: { "content-type": "application/json" } });
    let error: unknown;
    try {
      await executeCodexManagement({
        operation: "refresh",
        sessionId: "session-1",
        sidecarUrl: "http://127.0.0.1:8097",
      }, fetcher);
    } catch (cause: unknown) {
      error = cause;
    }

    expect(error).toBeInstanceOf(CodexManagementError);
    if (!(error instanceof CodexManagementError)) throw new TypeError("expected typed error");
    expect(error.kind).toBe(kind);
  });

  it("classifies a successful malformed response", async () => {
    const fetcher: typeof fetch = async () => new Response("not-json");

    await expect(executeCodexManagement({
      operation: "refresh",
      sessionId: "session-1",
      sidecarUrl: "http://127.0.0.1:8097",
    }, fetcher)).rejects.toMatchObject({ kind: "malformed" });
  });

  it("classifies a non-success application envelope", async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ code: 50301 }));

    await expect(executeCodexManagement({
      operation: "refresh",
      sessionId: "session-1",
      sidecarUrl: "http://127.0.0.1:8097",
    }, fetcher)).rejects.toMatchObject({ kind: "server" });
  });
});
