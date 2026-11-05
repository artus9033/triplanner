/** Token and search counts of one or more calls, and their cost at the plan's Opus 5.5 prices. */
export type LlmUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  web_search_requests: number;
};

const USD_PER_INPUT_TOKEN = 4 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 20 / 1_000_000;
const USD_PER_SEARCH = 0.01;

export const emptyUsage = (): LlmUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  web_search_requests: 0,
});

type SdkUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
};

export const fromSdkUsage = (usage: SdkUsage | null | undefined): LlmUsage => ({
  input_tokens: usage?.input_tokens ?? 0,
  output_tokens: usage?.output_tokens ?? 0,
  cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
  cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
  web_search_requests: usage?.server_tool_use?.web_search_requests ?? 0,
});

export const addUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  web_search_requests: a.web_search_requests + b.web_search_requests,
});

/** Ignores cache pricing, because these calls set no cache breakpoints. */
export const estimateCostUsd = (usage: LlmUsage): number =>
  (usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens) *
    USD_PER_INPUT_TOKEN +
  usage.output_tokens * USD_PER_OUTPUT_TOKEN +
  usage.web_search_requests * USD_PER_SEARCH;
