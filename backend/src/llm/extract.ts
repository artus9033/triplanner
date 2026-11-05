import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { CLAUDE_MODEL, EXTRACT_MAX_TOKENS, SEARCH_EFFORT } from "../config/llm";
import { getAnthropicClient } from "./client";
import { LlmError, toLlmError } from "./errors";
import { fromSdkUsage, type LlmUsage } from "./usage";

type JsonNode = {
  enum?: unknown[];
  properties?: Record<string, JsonNode>;
  items?: JsonNode;
  anyOf?: JsonNode[];
  oneOf?: JsonNode[];
};

/**
 * Rewrites string values to the schema's spelling of an enum value, ignoring case. This matters:
 * the SDK moves `enum` out of the schema it sends and into the description (see
 * lib/transform-json-schema), so the API does not constrain these values, and zod compares exactly.
 */
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
  /** Called with the token counts of the call, for cost records. */
  onUsage?: (usage: LlmUsage) => void;
};

/**
 * The extract call: structured output and no tools, so web content that tries to instruct the model
 * reaches a call that can do nothing. SDK constraints it relies on, checked against 1.5.0: length
 * and range limits are removed from the schema sent (they move to the description text) and
 * validated client-side. `messages.parse` throws on invalid output before the caller could see
 * stop_reason, so the parse step records the failure and returns null, leaving stop_reason first.
 */
export const extractStructured = async <S extends z.ZodType>(
  schema: S,
  { system, text, signal, onUsage }: ExtractRequest,
): Promise<z.infer<S>> => {
  const format = zodOutputFormat(schema);
  const enumTree = z.toJSONSchema(schema) as JsonNode;
  let parseFailure: string | null = null;
  const recordingFormat: typeof format = {
    ...format,
    parse: (content) => {
      try {
        const normalized = normalizeEnums(JSON.parse(content), enumTree);
        return format.parse(JSON.stringify(normalized));
      } catch (err) {
        parseFailure = err instanceof Error ? err.message : String(err);
        return null as z.infer<S>;
      }
    },
  };

  let message;
  try {
    message = await getAnthropicClient().messages.parse(
      {
        model: CLAUDE_MODEL,
        max_tokens: EXTRACT_MAX_TOKENS,
        output_config: { format: recordingFormat, effort: SEARCH_EFFORT },
        system,
        messages: [{ role: "user", content: text }],
      },
      { signal },
    );
  } catch (err) {
    throw toLlmError(err, signal);
  }
  onUsage?.(fromSdkUsage(message.usage));

  switch (message.stop_reason) {
    case "refusal":
      throw new LlmError("refusal");
    case "max_tokens":
    case "model_context_window_exceeded":
      throw new LlmError("max_tokens");
    case "end_turn":
      break;
    default:
      throw new LlmError("api", { detail: `unexpected stop_reason: ${message.stop_reason}` });
  }
  if (message.parsed_output === null || message.parsed_output === undefined) {
    throw new LlmError("extract_failed", {
      detail: `structured output failed validation: ${parseFailure ?? "no output"}`,
    });
  }
  return message.parsed_output as z.infer<S>;
};
