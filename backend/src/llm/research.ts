import { generateText, stepCountIs, tool } from "ai";
import type { Source } from "@triplanner/shared";
import { z } from "zod";
import { RESEARCH_MAX_TOKENS, SEARCH_EFFORT } from "../config/llm";
import { apexModel, effortOptions } from "./client";
import { LlmError, toLlmError } from "./errors";
import { fetchPage, PageError, type FetchedPage } from "./fetchPage";
import { fromSdkUsage, type LlmUsage } from "./usage";

export type ResearchResult = {
  text: string;
  /** Only pages that really loaded. These are what the app shows as sources. */
  pages: FetchedPage[];
  sources: Source[];
  model: string;
  usage: LlmUsage;
};

export type ResearchRequest = {
  system: string;
  prompt: string;
  maxFetches: number;
  signal?: AbortSignal;
};

let pageFetcher: typeof fetchPage = fetchPage;

export const setPageFetcherForTest = (fake: typeof fetchPage | null): void => {
  pageFetcher = fake ?? fetchPage;
};

/**
 * The research call. fetch_page is the only tool, and it runs here rather than on a server, so the
 * app knows exactly which pages were read. Apex has no web search of its own.
 */
export const runResearch = async ({
  system,
  prompt,
  maxFetches,
  signal,
}: ResearchRequest): Promise<ResearchResult> => {
  const pages = new Map<string, FetchedPage>();
  const attempted = new Set<string>();
  const startedAt = Date.now();

  const fetchTool = tool({
    description:
      "Fetch one public web page and return its text and links. It cannot search; give a full URL.",
    inputSchema: z.object({ url: z.string().describe("Full http or https URL") }),
    execute: async ({ url }) => {
      const known = pages.get(url);
      if (known) return known;
      if (attempted.size >= maxFetches) {
        return { error: "The page limit is reached. Answer with what you have." };
      }
      attempted.add(url);
      try {
        const page = await pageFetcher(url, { signal });
        pages.set(url, page);
        return page;
      } catch (err) {
        if (err instanceof PageError) return { error: err.message };
        if (signal?.aborted) throw err;
        return { error: "The page did not load." };
      }
    },
  });

  let result;
  try {
    result = await generateText({
      model: apexModel(),
      system,
      prompt,
      tools: { fetch_page: fetchTool },
      // One step per allowed fetch, plus the final answer.
      stopWhen: stepCountIs(maxFetches + 2),
      maxOutputTokens: RESEARCH_MAX_TOKENS,
      abortSignal: signal,
      providerOptions: effortOptions(SEARCH_EFFORT),
    });
  } catch (err) {
    throw toLlmError(err, signal);
  }

  if (result.finishReason === "content-filter") throw new LlmError("refusal");
  if (result.finishReason === "length") throw new LlmError("max_tokens");
  if (result.finishReason === "error") {
    throw new LlmError("api", { detail: "research finished with an error" });
  }

  // Two URLs can redirect to one page, which should count and show once.
  const loaded = [...new Map([...pages.values()].map((page) => [page.url, page])).values()];
  const usage = { ...fromSdkUsage(result.totalUsage), pages_fetched: loaded.length };
  const model = result.response.modelId;
  console.info(
    `[llm] research model=${model} ms=${Date.now() - startedAt} steps=${result.steps.length} ` +
      `pages=${loaded.length}/${attempted.size} in=${usage.input_tokens} out=${usage.output_tokens}`,
  );
  return {
    text: result.text.trim(),
    pages: loaded,
    sources: loaded.map(({ url, title }) => ({ url, title })),
    model,
    usage,
  };
};
