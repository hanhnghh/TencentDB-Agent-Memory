import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CODEX_HOOK_CONTEXT_LIMITS } from "../hook-service.js";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, "../../../plugins/tencentdb-agent-memory");

describe("Codex plugin hook package", () => {
  it("declares the completed-round lifecycle through one thin executable", async () => {
    const manifest: unknown = JSON.parse(await readFile(
      join(pluginRoot, ".codex-plugin/plugin.json"),
      "utf8",
    ));
    const hooks: unknown = JSON.parse(await readFile(join(pluginRoot, "hooks.json"), "utf8"));

    expect(manifest).toMatchObject({
      name: "tencentdb-agent-memory",
      version: "0.1.0",
    });
    expect(manifest).not.toHaveProperty("hooks");
    expect(hooks).toMatchObject({
      hooks: {
        SessionStart: [{ hooks: [{
          type: "command",
          additionalContextLimit: CODEX_HOOK_CONTEXT_LIMITS.SessionStart,
        }] }],
        UserPromptSubmit: [{ hooks: [{
          type: "command",
          additionalContextLimit: CODEX_HOOK_CONTEXT_LIMITS.UserPromptSubmit,
        }] }],
        PostToolUse: [{ hooks: [{ type: "command" }] }],
        Stop: [{ hooks: [{ type: "command" }] }],
        SessionEnd: [{ hooks: [{ type: "command" }] }],
      },
    });
    const serialized = JSON.stringify(hooks);
    expect(serialized.match(/memory-hook\.mjs/g)).toHaveLength(5);
    expect(serialized).toContain("PLUGIN_ROOT");
  });

  it.each([
    ["PostToolUse", "/hooks/post-tool-use", {
      model: "gpt-5",
      permission_mode: "default",
      tool_input: { cmd: "printf ok" },
      tool_name: "exec_command",
      tool_response: "ok",
      tool_use_id: "call-1",
    }],
    ["Stop", "/hooks/stop", {
      last_assistant_message: "done",
      model: "gpt-5",
      permission_mode: "default",
      stop_hook_active: false,
    }],
    ["SessionEnd", "/hooks/session-end", {}],
  ] as const)("forwards %s to its documented sidecar route", async (eventName, expectedPath, fields) => {
    let requestPath = "";
    const server = createServer((request, response) => {
      requestPath = request.url ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ suppressOutput: true }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
    try {
      const result = await runExecutable(JSON.stringify({
        cwd: "/workspace/project",
        hook_event_name: eventName,
        session_id: "session-1",
        transcript_path: null,
        turn_id: "turn-1",
        ...fields,
      }), `http://127.0.0.1:${address.port}`);

      expect(result.code).toBe(0);
      expect(requestPath).toBe(expectedPath);
      expect(JSON.parse(result.stdout)).toEqual({ suppressOutput: true });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("continues safely with valid empty hook output when the sidecar is unavailable", async () => {
    const input = JSON.stringify({
      cwd: "/workspace/project",
      hook_event_name: "SessionStart",
      model: "gpt-5",
      permission_mode: "default",
      session_id: "session-1",
      source: "startup",
      transcript_path: null,
    });
    const result = await runExecutable(input);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      suppressOutput: true,
      systemMessage: "Agent Memory sidecar is unavailable; continuing without injected context.",
    });
    expect(result.stderr).not.toContain("private prompt");
  });

  it.each([
    ["UserPromptSubmit", { prompt: "private prompt" }],
    ["PostToolUse", {
      tool_input: { cmd: "false" },
      tool_name: "exec_command",
      tool_response: "Process exited with code 1",
      tool_use_id: "call-1",
    }],
    ["Stop", {
      last_assistant_message: "private final response",
      stop_hook_active: false,
    }],
  ] as const)("does not acknowledge unavailable durable %s delivery", async (eventName, fields) => {
    const result = await runExecutable(JSON.stringify({
      cwd: "/workspace/project",
      hook_event_name: eventName,
      model: "gpt-5",
      permission_mode: "default",
      session_id: "session-1",
      transcript_path: null,
      turn_id: "turn-1",
      ...fields,
    }));

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("private");
  });

  it("rejects malformed success output from the sidecar before it reaches Codex", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        suppressOutput: false,
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: 42,
        },
        unexpected: "field",
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
    try {
      const result = await runExecutable(JSON.stringify({
        cwd: "/workspace/project",
        hook_event_name: "SessionStart",
        model: "gpt-5",
        permission_mode: "default",
        session_id: "session-1",
        source: "startup",
        transcript_path: null,
      }), `http://127.0.0.1:${address.port}`);

      expect(JSON.parse(result.stdout)).toEqual({
        suppressOutput: true,
        systemMessage: "Agent Memory sidecar is unavailable; continuing without injected context.",
      });
      expect(result.stderr).not.toContain("private prompt");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});

function runExecutable(
  input: string,
  sidecarUrl = "http://127.0.0.1:1",
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(pluginRoot, "scripts/memory-hook.mjs")], {
      env: {
        ...process.env,
        TDAI_MEMORY_SIDECAR_URL: sidecarUrl,
        TDAI_MEMORY_HOOK_TIMEOUT_MS: "50",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr }));
    child.stdin.end(input);
  });
}
