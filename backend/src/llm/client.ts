import { createOpenAI } from "@ai-sdk/openai";
import type { FeatureHealth } from "@triplanner/shared";
import { llmApiKey, llmBaseUrl, llmModelId } from "../config/env";
import { LlmError } from "./errors";

let testFetch: typeof fetch | null = null;

export const setApexFetchForTest = (fake: typeof fetch | null): void => {
  testFetch = fake;
};

const apiKey = (): string | undefined => llmApiKey() ?? (testFetch ? "test-key" : undefined);

/**
 * Always the chat endpoint. The SDK's default for this provider is /responses, where Apex rejects
 * the follow-up request of a tool loop with a 400 (item_reference is unsupported).
 */
export const llmModel = () => {
  const key = apiKey();
  if (!key) throw new LlmError("no_key");
  const provider = createOpenAI({
    apiKey: key,
    baseURL: llmBaseUrl(),
    name: "llm",
    ...(testFetch ? { fetch: testFetch } : {}),
  });
  return provider.chat(llmModelId());
};

/**
 * Sets reasoning effort. It must sit under the `openai` key: the chat model reads only that key, so
 * any other key is dropped without a warning and the request runs at the default effort.
 */
export const effortOptions = (effort: string) => ({ openai: { reasoningEffort: effort } });

/** Verifies the key with the model list, which uses no tokens. Never includes the key. */
export const checkLlmKey = async (): Promise<FeatureHealth> => {
  const key = apiKey();
  if (!key) return { status: "missing", detail: "LLM_API_KEY is not set" };
  const modelId = llmModelId();
  try {
    const res = await (testFetch ?? fetch)(`${llmBaseUrl()}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) return { status: "degraded", detail: "the API key was rejected" };
    if (res.status === 403) return { status: "degraded", detail: "the API key lacks permission" };
    if (!res.ok) return { status: "degraded", detail: `the API returned status ${res.status}` };
    const { data } = (await res.json()) as { data?: { id?: string }[] };
    return data?.some((model) => model.id === modelId)
      ? { status: "ready", detail: `key valid, model ${modelId} available` }
      : { status: "degraded", detail: `model ${modelId} is not available to this key` };
  } catch {
    return { status: "degraded", detail: "could not reach the LLM API" };
  }
};
