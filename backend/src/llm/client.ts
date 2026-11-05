import Anthropic from "@anthropic-ai/sdk";
import type { FeatureHealth } from "@triplanner/shared";
import { anthropicApiKey } from "../config/env";
import { CLAUDE_MODEL } from "../config/llm";
import { LlmError } from "./errors";

let client: Anthropic | null = null;
let testClient: Anthropic | null = null;

/** The key is passed explicitly: the user's .env names it CLAUDE_API_KEY, which the SDK ignores. */
export const getAnthropicClient = (): Anthropic => {
  if (testClient) return testClient;
  const apiKey = anthropicApiKey();
  if (!apiKey) throw new LlmError("no_key");
  client ??= new Anthropic({ apiKey });
  return client;
};

export const setAnthropicClientForTest = (fake: Anthropic | null): void => {
  testClient = fake;
};

/**
 * The only tool any call may send. This basic version is deliberate: web_search_20260209 and later
 * run search through server-side code execution, which breaks the "only web search" rule.
 */
export const webSearchTool = (maxUses: number) =>
  ({ type: "web_search_20250305", name: "web_search", max_uses: maxUses }) as const;

/** Verifies the key with the Models API, which uses no tokens. Never includes the key. */
export const checkLlmKey = async (): Promise<FeatureHealth> => {
  if (!testClient && !anthropicApiKey()) {
    return { status: "missing", detail: "ANTHROPIC_API_KEY is not set" };
  }
  try {
    const model = await getAnthropicClient().models.retrieve(CLAUDE_MODEL);
    return { status: "ready", detail: `key valid, model ${model.id} available` };
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (status === 401) return { status: "degraded", detail: "the API key was rejected" };
    if (status === 403) return { status: "degraded", detail: "the API key lacks permission" };
    if (status === 404) {
      return { status: "degraded", detail: `model ${CLAUDE_MODEL} is not available to this key` };
    }
    return {
      status: "degraded",
      detail:
        typeof status === "number"
          ? `the Models API returned status ${status}`
          : "could not reach the Claude API",
    };
  }
};
