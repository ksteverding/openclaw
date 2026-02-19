import { upsertAuthProfileWithLock } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
export const OLLAMA_DEFAULT_CONTEXT_WINDOW = 128000;
export const OLLAMA_DEFAULT_MAX_TOKENS = 8192;
export const OLLAMA_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
const OLLAMA_DEFAULT_API_KEY = "ollama-local";
const OLLAMA_DISCOVERY_TIMEOUT_MS = 5000;
const MANUAL_MODEL_OPTION = "__manual_model__";

type OllamaTagsResponse = {
  models?: Array<{
    name?: string;
  }>;
};

type OllamaDiscoveryResult = {
  modelIds: string[];
  error?: string;
};

function normalizeOllamaBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const withoutV1 = trimmed.replace(/\/v1$/i, "");
  return withoutV1 || OLLAMA_DEFAULT_BASE_URL;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error);
}

async function discoverOllamaModelIds(baseUrl: string): Promise<OllamaDiscoveryResult> {
  try {
    const endpoint = new URL("/api/tags", `${baseUrl}/`).href;
    const response = await fetchWithTimeout(
      endpoint,
      { method: "GET" },
      OLLAMA_DISCOVERY_TIMEOUT_MS,
    );
    if (!response.ok) {
      return { modelIds: [], error: `HTTP ${response.status}` };
    }

    const data = (await response.json()) as OllamaTagsResponse;
    const seen = new Set<string>();
    const modelIds: string[] = [];
    for (const model of data.models ?? []) {
      const name = typeof model.name === "string" ? model.name.trim() : "";
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      modelIds.push(name);
    }
    if (modelIds.length === 0) {
      return { modelIds: [], error: "No models found via /api/tags" };
    }

    return { modelIds };
  } catch (error) {
    return { modelIds: [], error: formatErrorMessage(error) };
  }
}

async function promptManualModelId(prompter: WizardPrompter): Promise<string> {
  const modelIdRaw = await prompter.text({
    message: "Ollama model ID",
    placeholder: "llama3.2:latest",
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  return String(modelIdRaw ?? "").trim();
}

export async function promptAndConfigureOllama(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  agentDir?: string;
}): Promise<{ config: OpenClawConfig; modelId: string; modelRef: string }> {
  const baseUrlRaw = await params.prompter.text({
    message: "Ollama base URL",
    initialValue: OLLAMA_DEFAULT_BASE_URL,
    placeholder: OLLAMA_DEFAULT_BASE_URL,
    validate: (value) => {
      const trimmed = value?.trim() ?? "";
      if (!trimmed) {
        return "Required";
      }
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return "URL must start with http:// or https://";
        }
      } catch {
        return "Must be a valid URL";
      }
      return undefined;
    },
  });
  const apiKeyRaw = await params.prompter.text({
    message: "Ollama API key",
    initialValue: OLLAMA_DEFAULT_API_KEY,
    placeholder: OLLAMA_DEFAULT_API_KEY,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });

  const baseUrl = normalizeOllamaBaseUrl(String(baseUrlRaw ?? ""));
  const apiKey = String(apiKeyRaw ?? "").trim();

  let modelId: string;
  const discovered = await discoverOllamaModelIds(baseUrl);
  if (discovered.modelIds.length > 0) {
    const selected = await params.prompter.select<string>({
      message: "Select Ollama model",
      options: [
        ...discovered.modelIds.map((id) => ({ value: id, label: id })),
        { value: MANUAL_MODEL_OPTION, label: "Enter model ID manually" },
      ],
      initialValue: discovered.modelIds[0],
    });
    modelId =
      selected === MANUAL_MODEL_OPTION
        ? await promptManualModelId(params.prompter)
        : String(selected ?? "").trim();
  } else {
    const detail = discovered.error ? ` (${discovered.error})` : "";
    await params.prompter.note(
      `Could not auto-discover Ollama models from ${baseUrl}${detail}. Enter a model ID manually.`,
      "Ollama model discovery",
    );
    modelId = await promptManualModelId(params.prompter);
  }

  const modelRef = `ollama/${modelId}`;

  await upsertAuthProfileWithLock({
    profileId: "ollama:default",
    credential: { type: "api_key", provider: "ollama", key: apiKey },
    agentDir: params.agentDir,
  });

  const nextConfig: OpenClawConfig = {
    ...params.cfg,
    models: {
      ...params.cfg.models,
      mode: params.cfg.models?.mode ?? "merge",
      providers: {
        ...params.cfg.models?.providers,
        ollama: {
          baseUrl,
          api: "ollama",
          apiKey: "OLLAMA_API_KEY",
          models: [
            {
              id: modelId,
              name: modelId,
              reasoning: false,
              input: ["text"],
              cost: OLLAMA_DEFAULT_COST,
              contextWindow: OLLAMA_DEFAULT_CONTEXT_WINDOW,
              maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
            },
          ],
        },
      },
    },
  };

  return { config: nextConfig, modelId, modelRef };
}
