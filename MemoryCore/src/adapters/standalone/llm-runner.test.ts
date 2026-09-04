import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: generateTextMock,
  };
});

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({
    chat: (model: string) => ({ model }),
  }),
}));

import { StandaloneLLMRunner } from "./llm-runner.js";

describe("StandaloneLLMRunner OpenAI-compatible requests", () => {
  beforeEach(() => {
    generateTextMock.mockResolvedValue({
      text: "done",
      totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      steps: [],
    });
  });

  it("disables reasoning effort when a GPT-5 reasoning model uses tools over Chat Completions", async () => {
    const runner = new StandaloneLLMRunner({
      config: {
        baseUrl: "http://llm.example/v1",
        apiKey: "test-key",
        model: "gpt-5.6-luna",
      },
    });

    await runner.run({
      taskId: "reasoning-tools-compatibility",
      prompt: "Use the noop tool if needed.",
      enableTools: true,
      tools: { noop: { description: "Do nothing." } },
    });

    expect(generateTextMock).toHaveBeenCalledWith(expect.objectContaining({
      model: { model: "gpt-5.6-luna" },
      tools: expect.any(Object),
      providerOptions: {
        openai: { reasoningEffort: "none" },
      },
    }));
  });

  it("keeps provider defaults for non-reasoning models that use tools", async () => {
    const runner = new StandaloneLLMRunner({
      config: {
        baseUrl: "http://llm.example/v1",
        apiKey: "test-key",
        model: "gpt-4.1-mini",
      },
    });

    await runner.run({
      taskId: "regular-tools",
      prompt: "Use a tool if needed.",
      enableTools: true,
      tools: { noop: { description: "Do nothing." } },
    });

    expect(generateTextMock.mock.calls.at(-1)?.[0]).not.toHaveProperty("providerOptions");
  });

  it("keeps provider reasoning defaults for text-only GPT-5 requests", async () => {
    const runner = new StandaloneLLMRunner({
      config: {
        baseUrl: "http://llm.example/v1",
        apiKey: "test-key",
        model: "gpt-5.6-luna",
      },
    });

    await runner.run({
      taskId: "reasoning-text-only",
      prompt: "Summarise this conversation.",
    });

    expect(generateTextMock.mock.calls.at(-1)?.[0]).not.toHaveProperty("providerOptions");
  });
});
