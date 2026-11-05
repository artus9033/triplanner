import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { llmBaseUrl, llmModelId } from "../config/env";
import { RESEARCH_MAX_TOKENS, SEARCH_EFFORT } from "../config/llm";
import { setApexFetchForTest } from "./client";
import { PageError, type fetchPage } from "./fetchPage";
import { runResearch, setPageFetcherForTest } from "./research";
import { chat, fakeFetch, fetchCall, jsonResponse, type Reply } from "./testApi";

const page = (url: string) => ({ url, title: `Title of ${url}`, text: `Text of ${url}` });
let pages: ReturnType<typeof vi.fn>;

const run = (replies: Reply[], maxFetches = 3) => {
  const fake = fakeFetch(replies);
  setApexFetchForTest(fake.fetchFn);
  return {
    requests: fake.requests,
    result: runResearch({ system: "sys", prompt: "find", maxFetches }),
  };
};

beforeEach(() => {
  pages = vi.fn(async (url: string) => page(url));
  setPageFetcherForTest(pages as unknown as typeof fetchPage);
});
afterEach(() => {
  setApexFetchForTest(null);
  setPageFetcherForTest(null);
});

describe("runResearch", () => {
  it("sends only fetch_page to the chat endpoint, with effort, and no output format", async () => {
    const { requests, result } = run([chat({ content: "done" })]);
    await result;
    const { url, body } = requests[0]!;
    expect(url).toBe(`${llmBaseUrl()}/chat/completions`);
    expect(body.model).toBe(llmModelId());
    expect(body.reasoning_effort).toBe(SEARCH_EFFORT);
    expect(body.max_tokens).toBe(RESEARCH_MAX_TOKENS);
    expect(body.tools.map((t: any) => t.function.name)).toEqual(["fetch_page"]);
    expect(body.response_format).toBeUndefined();
    expect(body.tool_choice).toBe("auto");
    for (const key of ["temperature", "top_p", "top_k"]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("runs the tool loop and reports only pages that really loaded as sources", async () => {
    pages.mockImplementation(async (url: string) => {
      if (url.includes("bad")) throw new PageError("The page returned status 403.");
      return page(url);
    });
    const { requests, result } = run([
      fetchCall("https://bad.example/"),
      fetchCall("https://good.example/hours"),
      chat({ content: "  Open daily.  " }),
    ]);
    const research = await result;
    expect(research.text).toBe("Open daily.");
    expect(research.sources).toEqual([
      { url: "https://good.example/hours", title: "Title of https://good.example/hours" },
    ]);
    expect(research.usage).toMatchObject({ input_tokens: 30, output_tokens: 15, pages_fetched: 1 });
    expect(research.model).toBe("callstack/Apex");
    const toolMessages = requests[2]!.body.messages.filter((m: any) => m.role === "tool");
    expect(toolMessages[0].content).toContain("status 403");
    expect(toolMessages[1].content).toContain("Text of https://good.example/hours");
  });

  it("enforces the page limit in code, and the step limit ends a model that keeps going", async () => {
    const { requests, result } = run(
      [
        fetchCall("https://a.example/1"),
        fetchCall("https://a.example/2"),
        fetchCall("https://a.example/3"),
        fetchCall("https://a.example/4"),
      ],
      2,
    );
    const research = await result;
    expect(pages).toHaveBeenCalledTimes(2);
    expect(research.pages).toHaveLength(2);
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(requests[3]!.body.messages)).toContain("page limit is reached");
  });

  it("serves a repeated URL from memory, without using up the limit", async () => {
    const { result } = run(
      [
        fetchCall("https://a.example/1"),
        fetchCall("https://a.example/1"),
        fetchCall("https://a.example/2"),
        chat({ content: "ok" }),
      ],
      2,
    );
    const research = await result;
    expect(pages).toHaveBeenCalledTimes(2);
    expect(research.pages).toHaveLength(2);
  });

  it("lists a page once when two URLs redirect to it", async () => {
    pages.mockImplementation(async () => page("https://a.example/final"));
    const { result } = run([
      fetchCall("https://a.example/one"),
      fetchCall("https://a.example/two"),
      chat({ content: "ok" }),
    ]);
    expect((await result).sources.map((s) => s.url)).toEqual(["https://a.example/final"]);
  });

  it("an unknown tool failure is a tool error, not a crash", async () => {
    pages.mockRejectedValueOnce(new Error("/internal/path exploded"));
    const { requests, result } = run([fetchCall("https://a.example/"), chat({ content: "ok" })]);
    const research = await result;
    expect(research.pages).toEqual([]);
    expect(JSON.stringify(requests[1]!.body.messages)).not.toContain("/internal/path");
  });

  it("maps refusal and cut-off answers, so nothing incomplete is stored", async () => {
    await expect(run([chat({ finish: "content_filter" })]).result).rejects.toMatchObject({
      code: "refusal",
    });
    await expect(run([chat({ finish: "length" })]).result).rejects.toMatchObject({
      code: "max_tokens",
    });
  });

  it("maps API errors without leaking their text to the screen", async () => {
    const reply = jsonResponse({ error: { message: "upstream secret detail" } }, 400);
    const failure = await run([reply]).result.catch((e) => e);
    expect(failure.code).toBe("api");
    expect(failure.userMessage).not.toContain("secret");
  });
});
