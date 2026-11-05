import { createOpenAI } from "@ai-sdk/openai";
import type { FeatureHealth } from "@triplanner/shared";
import { apexApiKey } from "../config/env";
import { APEX_BASE_URL, APEX_MODEL } from "../config/llm";
import { LlmError } from "./errors";

let testFetch: typeof fetch | null = null;

export const setApexFetchForTest = (fake: typeof fetch | null): void => {
  testFetch = fake;
};

const apiKey = (): string | undefined => apexApiKey() ?? (testFetch ? "test-key" : undefined);

/**
 * Always the chat endpoint. The SDK's default for this provider is /responses, where Apex rejects
 * the follow-up request of a tool loop with a 400 (item_reference is unsupported).
 */
export const apexModel = () => {
  const key = apiKey();
  if (!key) throw new LlmError("no_key");
  const provider = createOpenAI({
    apiKey: key,
    baseURL: APEX_BASE_URL,
    name: "callstack",
    ...(testFetch ? { fetch: testFetch } : {}),
  });
  return provider.chat(APEX_MODEL);
};

/**
 * Sets reasoning effort. It must sit under the `openai` key: the chat model reads only that key, so
 * `callstack` is dropped without a warning and the request runs at the default effort.
 */
export const effortOptions = (effort: string) => ({ openai: { reasoningEffort: effort } });

/** Verifies the key with the model list, which uses no tokens. Never includes the key. */
export const checkLlmKey = async (): Promise<FeatureHealth> => {
  const key = apiKey();
  if (!key) return { status: "missing", detail: "APEX_API_KEY is not set" };
  try {
    const res = await (testFetch ?? fetch)(`${APEX_BASE_URL}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) return { status: "degraded", detail: "the API key was rejected" };
    if (res.status === 403) return { status: "degraded", detail: "the API key lacks permission" };
    if (!res.ok) return { status: "degraded", detail: `the API returned status ${res.status}` };
    const { data } = (await res.json()) as { data?: { id?: string }[] };
    return data?.some((model) => model.id === APEX_MODEL)
      ? { status: "ready", detail: `key valid, model ${APEX_MODEL} available` }
      : { status: "degraded", detail: `model ${APEX_MODEL} is not available to this key` };
  } catch {
    return { status: "degraded", detail: "could not reach the Apex API" };
  }
};
