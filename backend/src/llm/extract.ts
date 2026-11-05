import { generateText, jsonSchema, Output, type JSONSchema7 } from "ai";
import { z } from "zod";
import { EXTRACT_MAX_TOKENS, SEARCH_EFFORT } from "../config/llm";
import { apexModel, effortOptions } from "./client";
import { LlmError, structuredOutputError } from "./errors";
import { fromSdkUsage, type LlmUsage } from "./usage";

type JsonNode = {
  enum?: unknown[];
  properties?: Record<string, JsonNode>;
  items?: JsonNode;
  anyOf?: JsonNode[];
  oneOf?: JsonNode[];
};

/** Rewrites string values to the schema's spelling of an enum value, ignoring case. */
export const normalizeEnums = (value: unknown, node: JsonNode | undefined): unknown => {
  if (!node) return value;
  if (typeof value === "string" && node.enum) {
    const wanted = value.trim().toLowerCase();
    return node.enum.find((v) => typeof v === "string" && v.toLowerCase() === wanted) ?? value;
  }
  for (const variant of node.anyOf ?? node.oneOf ?? []) {
    const normalized = normalizeEnums(value, variant);
    if (normalized !== value) return normalized;
    if (value !== null && typeof value === "object") {
      const isArray = Array.isArray(value);
      if (isArray && variant.items) return normalizeEnums(value, variant);
      if (!isArray && variant.properties) return normalizeEnums(value, variant);
    }
  }
  if (Array.isArray(value)) return value.map((item) => normalizeEnums(item, node.items));
  if (value !== null && typeof value === "object" && node.properties) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeEnums(item, node.properties?.[key]),
      ]),
    );
  }
  return value;
};

export type ExtractRequest = {
  system: string;
  text: string;
  signal?: AbortSignal;
  /** Called with the token counts of the call. */
  onUsage?: (usage: LlmUsage) => void;
};

/**
 * The extract call: structured output and no tools, so web content that tries to instruct the model
 * reaches a call that can do nothing. Validation is done here so that enums can be compared without
 * regard to case, and so a violated limit is a failed extraction.
 */
export const extractStructured = async <S extends z.ZodType>(
  schema: S,
  { system, text, signal, onUsage }: ExtractRequest,
): Promise<z.infer<S>> => {
  const wireSchema = z.toJSONSchema(schema);
  let result;
  let output: unknown;
  try {
    result = await generateText({
      model: apexModel(),
      system,
      prompt: text,
      output: Output.object({ schema: jsonSchema(wireSchema as JSONSchema7) }),
      maxOutputTokens: EXTRACT_MAX_TOKENS,
      abortSignal: signal,
      providerOptions: effortOptions(SEARCH_EFFORT),
    });
    // Stop reasons come first: a refused or truncated answer is not a parsing problem.
    if (result.finishReason === "content-filter") throw new LlmError("refusal");
    if (result.finishReason === "length") throw new LlmError("max_tokens");
    output = result.output;
  } catch (err) {
    throw structuredOutputError(err, signal);
  }
  onUsage?.(fromSdkUsage(result.totalUsage));

  const parsed = schema.safeParse(normalizeEnums(output, wireSchema as JsonNode));
  if (!parsed.success) {
    throw new LlmError("extract_failed", {
      detail: `structured output failed validation: ${parsed.error.message}`,
    });
  }
  return parsed.data;
};
