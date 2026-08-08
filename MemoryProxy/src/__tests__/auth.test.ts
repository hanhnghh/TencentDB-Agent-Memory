import { afterEach, describe, expect, it, vi } from "vitest";

import {
  initAuth,
  verifyUserKey,
  verifyUserKeyWithConfig,
} from "../auth.js";

afterEach(() => {
  initAuth({ enabled: false, url: "", timeoutMs: 0 });
  vi.unstubAllGlobals();
});

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200 });
}

describe("user-key verifier extraction", () => {
  it("preserves the legacy verifier result and request contract", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://auth.example/v3/meta/auth/verify");
      expect(new Headers(init?.headers).get("x-tdai-service-id")).toBe("memory-1");
      expect(JSON.parse(String(init?.body))).toEqual({ user_key: "user-key-secret" });
      return jsonResponse({
        code: 0,
        data: { valid: true, user: { user_id: "user-1" } },
      });
    }) as typeof fetch;
    vi.stubGlobal("fetch", fetcher);
    initAuth({ enabled: true, url: "https://auth.example/", timeoutMs: 5_000 });

    await expect(verifyUserKey("user-key-secret", "memory-1")).resolves.toEqual({
      userId: "user-1",
      rejected: false,
    });
    await expect(verifyUserKeyWithConfig(
      { url: "https://auth.example/", timeoutMs: 5_000 },
      "user-key-secret",
      "memory-1",
      fetcher,
    )).resolves.toEqual({
      userId: "user-1",
      rejected: false,
    });
  });

  it("rejects malformed success identities through the legacy verifier", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      code: 0,
      data: { valid: true, user: { user_id: { value: "user-1" } } },
    })));
    initAuth({ enabled: true, url: "https://auth.example", timeoutMs: 5_000 });

    await expect(verifyUserKey("user-key-secret", "memory-1")).resolves.toEqual({
      userId: "",
      rejected: true,
      rejectReason: "unexpected verify response (code=0)",
    });
  });
});
