import type Anthropic from "@anthropic-ai/sdk";
import type { Source } from "@triplanner/shared";
import {
  CLAUDE_MODEL,
  FALLBACK_BETA,
  MAX_PAUSE_CONTINUATIONS,
  RESEARCH_MAX_TOKENS,
  SEARCH_EFFORT,
} from "../config/llm";
import { getAnthropicClient, webSearchTool } from "./client";
import { LlmError, toLlmError } from "./errors";
import { addUsage, emptyUsage, fromSdkUsage, type LlmUsage } from "./usage";
import { httpUrlOrNull } from "./validate";

type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

/** One citation with the text around it, so a caller can tell which place it speaks about. */
export type Citation = Source & { citedText: string; blockText: string };

export type ResearchResult = {
  text: string;
  sources: Source[];
  citations: Citation[];
  /** The model that answered, after any server-side fallback. */
  model: string;
  usage: LlmUsage;
  searchCount: number;
};

export type ResearchRequest = {
  system: string;
  prompt: string;
  maxUses: number;
  signal?: AbortSignal;
};

/** Plan rule: web search only. The tool version sent already excludes these, so this is a guard. */
export const assertWebSearchOnly = (content: ContentBlock[]): void => {
  for (const block of content) {
    const offending =
      block.type.includes("code_execution") ||
      block.type === "web_fetch_tool_result" ||
      (block.type === "server_tool_use" &&
        (block.name !== "web_search" || (block.caller && block.caller.type !== "direct")));
    if (offending) {
      throw new LlmError("api", {
        userMessage: "Claude used a tool this app does not allow, so the result was discarded.",
        detail: `disallowed block in research response: ${block.type}`,
      });
    }
  }
};

export const collectCitations = (content: ContentBlock[]): Citation[] => {
  const citations: Citation[] = [];
  for (const block of content) {
    if (block.type !== "text") continue;
    for (const citation of block.citations ?? []) {
      if (citation.type !== "web_search_result_location") continue;
      const url = httpUrlOrNull(citation.url);
      if (!url) continue;
      citations.push({
        url,
        title: citation.title ?? null,
        citedText: citation.cited_text,
        blockText: block.text,
      });
    }
  }
  return citations;
};

export const dedupeSources = (citations: Source[]): Source[] => {
  const byUrl = new Map<string, Source>();
  for (const { url, title } of citations) {
    const seen = byUrl.get(url);
    if (!seen) byUrl.set(url, { url, title });
    else seen.title ??= title;
  }
  return [...byUrl.values()];
};

/**
 * Search errors arrive as HTTP 200 with an error object in place of the result list; an empty list
 * just means no results. Judgement call: when at least one search in the turn returned (even an
 * empty list), the model had real search output, so a later transient error (or max_uses_exceeded)
 * only narrows the answer. It is logged and the answer kept. When every search errored, any answer
 * could only come from the model's memory, with nothing behind it, so it fails as search_error.
 */
const checkSearchErrors = (content: ContentBlock[]): void => {
  const results = content.filter((b) => b.type === "web_search_tool_result");
  const errors = results.flatMap((b) => (Array.isArray(b.content) ? [] : [b.content.error_code]));
  if (errors.length === 0) return;
  if (errors.length === results.length) {
    throw new LlmError("search_error", { detail: `web search errors: ${errors.join(", ")}` });
  }
  console.warn(`[llm] research kept despite web search errors: ${errors.join(", ")}`);
};

/**
 * The research call: web search and nothing else, no output format. Stop reasons are branched on
 * before content is read, and paused turns are sent back unchanged with the same tools.
 */
export const runResearch = async ({
  system,
  prompt,
  maxUses,
  signal,
}: ResearchRequest): Promise<ResearchResult> => {
  const client = getAnthropicClient();
  const tools = [webSearchTool(maxUses)];
  const messages: MessageParam[] = [{ role: "user", content: prompt }];
  const content: ContentBlock[] = [];
  const startedAt = Date.now();
  let usage = emptyUsage();

  for (let continuations = 0; ; continuations++) {
    let response: Anthropic.Beta.Messages.BetaMessage;
    try {
      response = await client.beta.messages.create(
        {
          model: CLAUDE_MODEL,
          max_tokens: RESEARCH_MAX_TOKENS,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          output_config: { effort: SEARCH_EFFORT },
          system,
          tools,
          messages,
        },
        { signal },
      );
    } catch (err) {
      throw toLlmError(err, signal);
    }
    usage = addUsage(usage, fromSdkUsage(response.usage));

    switch (response.stop_reason) {
      case "refusal":
        throw new LlmError("refusal");
      case "max_tokens":
      case "model_context_window_exceeded":
        throw new LlmError("max_tokens");
      case "pause_turn":
        assertWebSearchOnly(response.content);
        content.push(...response.content);
        if (continuations >= MAX_PAUSE_CONTINUATIONS) {
          throw new LlmError("api", {
            userMessage:
              "The web search did not finish in time, so there is no result. You can retry.",
            detail: `still paused after ${continuations} continuations`,
          });
        }
        messages.push({
          role: "assistant",
          content: response.content as Anthropic.Beta.Messages.BetaContentBlockParam[],
        });
        continue;
      case "end_turn":
        assertWebSearchOnly(response.content);
        content.push(...response.content);
        break;
      default:
        throw new LlmError("api", { detail: `unexpected stop_reason: ${response.stop_reason}` });
    }

    checkSearchErrors(content);
    const text = content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();
    if (!text) throw new LlmError("api", { detail: "research response has no text" });

    const citations = collectCitations(content);
    const fallback = response.model !== CLAUDE_MODEL ? ` requested=${CLAUDE_MODEL}` : "";
    console.info(
      `[llm] research model=${response.model}${fallback} ms=${Date.now() - startedAt} ` +
        `searches=${usage.web_search_requests} continuations=${continuations} ` +
        `in=${usage.input_tokens} out=${usage.output_tokens}`,
    );
    return {
      text,
      sources: dedupeSources(citations),
      citations,
      model: response.model,
      usage,
      searchCount: usage.web_search_requests,
    };
  }
};
