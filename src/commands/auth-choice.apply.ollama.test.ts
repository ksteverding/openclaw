import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoiceOllama } from "./auth-choice.apply.ollama.js";

const promptAndConfigureOllama = vi.hoisted(() => vi.fn());

vi.mock("./ollama-setup.js", () => ({
  promptAndConfigureOllama,
}));

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as RuntimeEnv["exit"],
  };
}

function createPrompter(): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async () => "") as WizardPrompter["select"],
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => ""),
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
}

describe("applyAuthChoiceOllama", () => {
  it("returns null for non-ollama auth choices", async () => {
    const result = await applyAuthChoiceOllama({
      authChoice: "openai-api-key",
      config: {},
      prompter: createPrompter(),
      runtime: createRuntime(),
      setDefaultModel: true,
    });

    expect(result).toBeNull();
    expect(promptAndConfigureOllama).not.toHaveBeenCalled();
  });

  it("returns model override when setDefaultModel is false", async () => {
    const prompter = createPrompter();
    const config = { foo: "bar" } as unknown as Record<string, unknown>;
    promptAndConfigureOllama.mockResolvedValueOnce({
      config,
      modelRef: "ollama/llama3.2:latest",
    });

    const result = await applyAuthChoiceOllama({
      authChoice: "ollama",
      config: {},
      prompter,
      runtime: createRuntime(),
      setDefaultModel: false,
      agentDir: "/tmp/agent",
    });

    expect(promptAndConfigureOllama).toHaveBeenCalledWith({
      cfg: {},
      prompter,
      agentDir: "/tmp/agent",
    });
    expect(result).toEqual({
      config,
      agentModelOverride: "ollama/llama3.2:latest",
    });
    expect(prompter.note).not.toHaveBeenCalled();
  });

  it("sets default model and preserves fallbacks when setDefaultModel is true", async () => {
    const prompter = createPrompter();
    promptAndConfigureOllama.mockResolvedValueOnce({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.1",
              fallbacks: ["openai/gpt-5-nano"],
            },
          },
        },
      },
      modelRef: "ollama/llama3.2:latest",
    });

    const result = await applyAuthChoiceOllama({
      authChoice: "ollama",
      config: {},
      prompter,
      runtime: createRuntime(),
      setDefaultModel: true,
    });

    expect(result?.config.agents?.defaults?.model).toEqual({
      primary: "ollama/llama3.2:latest",
      fallbacks: ["openai/gpt-5-nano"],
    });
    expect(prompter.note).toHaveBeenCalledWith(
      "Default model set to ollama/llama3.2:latest",
      "Model configured",
    );
  });
});
