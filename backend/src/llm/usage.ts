/** Token and page counts of one or more calls. Apex's prices are not published here, so no cost. */
export type LlmUsage = { input_tokens: number; output_tokens: number; pages_fetched: number };

export const emptyUsage = (): LlmUsage => ({ input_tokens: 0, output_tokens: 0, pages_fetched: 0 });

export const fromSdkUsage = (
  usage: { inputTokens?: number; outputTokens?: number } | null | undefined,
): LlmUsage => ({
  input_tokens: usage?.inputTokens ?? 0,
  output_tokens: usage?.outputTokens ?? 0,
  pages_fetched: 0,
});

export const addUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  pages_fetched: a.pages_fetched + b.pages_fetched,
});
