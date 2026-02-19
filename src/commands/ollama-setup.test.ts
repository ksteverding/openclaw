import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  OLLAMA_DEFAULT_CONTEXT_WINDOW,
  OLLAMA_DEFAULT_COST,
  OLLAMA_DEFAULT_MAX_TOKENS,
  promptAndConfigureOllama,
} from "./ollama-setup.js";
import { makePrompter } from "./onboarding/__tests__/test-utils.js";

const upsertAuthProfileWithLock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../agents/auth-profiles.js", () => ({
  upsertAuthProfileWithLock,
}));

const fetchWithTimeout = vi.hoisted(() => vi.fn());
vi.mock("../utils/fetch-timeout.js", () => ({
  fetchWithTimeout,
}));

function createOllamaTagsResponse(modelIds: string[]): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn(async () => ({
      models: modelIds.map((name) => ({ name })),
    })),
  } as unknown as Response;
}

describe("promptAndConfigureOllama", () => {
  beforeEach(() => {
    fetchWithTimeout.mockReset();
    upsertAuthProfileWithLock.mockReset();
    upsertAuthProfileWithLock.mockResolvedValue(undefined);
  });

  it("discovers models and configures selected model", async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      createOllamaTagsResponse(["llama3.2:latest", "qwen2.5"]),
    );

    const text = vi
      .fn<WizardPrompter["text"]>()
      .mockResolvedValueOnce("http://ollama-host:11434")
      .mockResolvedValueOnce("sk-ollama-test");
    const select = vi.fn(async () => "qwen2.5" as never) as WizardPrompter["select"];
    const prompter = makePrompter({
      text,
      select,
    });

    const result = await promptAndConfigureOllama({
      cfg: {},
      prompter,
      agentDir: "/tmp/openclaw-agent",
    });

    expect(fetchWithTimeout).toHaveBeenCalledWith(
      "http://ollama-host:11434/api/tags",
      { method: "GET" },
      5000,
    );
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Select Ollama model",
        options: expect.arrayContaining([
          expect.objectContaining({ value: "llama3.2:latest" }),
          expect.objectContaining({ value: "qwen2.5" }),
          expect.objectContaining({ value: "__manual_model__", label: "Enter model ID manually" }),
        ]),
      }),
    );
    expect(result.modelId).toBe("qwen2.5");
    expect(result.modelRef).toBe("ollama/qwen2.5");
    expect(result.config.models?.providers?.ollama).toEqual({
      baseUrl: "http://ollama-host:11434",
      api: "ollama",
      apiKey: "OLLAMA_API_KEY",
      models: [
        {
          id: "qwen2.5",
          name: "qwen2.5",
          reasoning: false,
          input: ["text"],
          cost: OLLAMA_DEFAULT_COST,
          contextWindow: OLLAMA_DEFAULT_CONTEXT_WINDOW,
          maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
        },
      ],
    });
    expect(upsertAuthProfileWithLock).toHaveBeenCalledWith({
      profileId: "ollama:default",
      credential: { type: "api_key", provider: "ollama", key: "sk-ollama-test" },
      agentDir: "/tmp/openclaw-agent",
    });
  });

  it("falls back to manual model input when discovery fails", async () => {
    fetchWithTimeout.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:11434"));

    const text = vi
      .fn<WizardPrompter["text"]>()
      .mockResolvedValueOnce("http://127.0.0.1:11434")
      .mockResolvedValueOnce("ollama-local")
      .mockResolvedValueOnce("llama3.2:latest");
    const note = vi.fn<WizardPrompter["note"]>().mockResolvedValue(undefined);
    const prompter = makePrompter({
      text,
      note,
    });

    const result = await promptAndConfigureOllama({
      cfg: {},
      prompter,
    });

    expect(prompter.select).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Could not auto-discover Ollama models from http://127.0.0.1:11434"),
      "Ollama model discovery",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("connect ECONNREFUSED 127.0.0.1:11434"),
      "Ollama model discovery",
    );
    expect(result.modelId).toBe("llama3.2:latest");
    expect(result.modelRef).toBe("ollama/llama3.2:latest");
  });

  it("supports choosing manual model entry even when discovery succeeds", async () => {
    fetchWithTimeout.mockResolvedValueOnce(createOllamaTagsResponse(["llama3.2:latest"]));

    const text = vi
      .fn<WizardPrompter["text"]>()
      .mockResolvedValueOnce("http://127.0.0.1:11434")
      .mockResolvedValueOnce("ollama-local")
      .mockResolvedValueOnce("deepseek-r1:32b");
    const select = vi.fn(async () => "__manual_model__" as never) as WizardPrompter["select"];
    const prompter = makePrompter({
      text,
      select,
    });

    const result = await promptAndConfigureOllama({
      cfg: {},
      prompter,
    });

    expect(select).toHaveBeenCalledTimes(1);
    expect(result.modelId).toBe("deepseek-r1:32b");
    expect(result.modelRef).toBe("ollama/deepseek-r1:32b");
  });

  it("normalizes base URL by trimming suffix /v1 and trailing slashes", async () => {
    fetchWithTimeout.mockResolvedValueOnce(createOllamaTagsResponse(["gpt-oss:20b"]));

    const text = vi
      .fn<WizardPrompter["text"]>()
      .mockResolvedValueOnce("https://remote-ollama.example.com:11434/v1/")
      .mockResolvedValueOnce("ollama-local");
    const select = vi.fn(async () => "gpt-oss:20b" as never) as WizardPrompter["select"];
    const prompter = makePrompter({
      text,
      select,
    });

    const result = await promptAndConfigureOllama({
      cfg: {},
      prompter,
    });

    expect(fetchWithTimeout).toHaveBeenCalledWith(
      "https://remote-ollama.example.com:11434/api/tags",
      { method: "GET" },
      5000,
    );
    expect(result.config.models?.providers?.ollama?.baseUrl).toBe(
      "https://remote-ollama.example.com:11434",
    );
  });
});
