import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PAUSE_CONTINUATIONS, SEARCH_EFFORT } from "../config/llm";
import { setAnthropicClientForTest, webSearchTool } from "./client";
import { LlmError } from "./errors";
import { runResearch } from "./research";
import { citedText, fakeClient, jsonResponse, message, searchBlocks, type Reply } from "./testApi";

const run = (replies: Reply[], maxUses = 3) => {
  const { client, requests } = fakeClient(replies);
  setAnthropicClientForTest(client);
  return { promise: runResearch({ system: "sys", prompt: "find", maxUses }), requests };
};

const failure = async (promise: Promise<unknown>): Promise<LlmError> => {
  const err = await promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LlmError);
  return err as LlmError;
};

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  setAnthropicClientForTest(null);
  vi.restoreAllMocks();
});

describe("webSearchTool", () => {
  it("is exactly the plan's tool", () => {
    expect(webSearchTool(7)).toEqual({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 7,
    });
  });
});

describe("runResearch request", () => {
  it("sends exactly the one tool, fallback, effort, and no forbidden params", async () => {
    const { promise, requests } = run([message()]);
    await promise;
    const { body, headers } = requests[0]!;
    expect(body.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]);
    expect(body.fallbacks).toBe("default");
    expect(headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    expect(body.output_config).toEqual({ effort: SEARCH_EFFORT });
    for (const key of ["temperature", "top_p", "top_k", "thinking", "tool_choice", "betas"]) {
      expect(body).not.toHaveProperty(key);
    }
  });
});

describe("runResearch stop reasons", () => {
  it("refusal fails even when content looks fine", async () => {
    const err = await failure(run([message({ stop_reason: "refusal" })]).promise);
    expect(err.code).toBe("refusal");
  });

  it("max_tokens fails and does not return partial text", async () => {
    const err = await failure(run([message({ stop_reason: "max_tokens" })]).promise);
    expect(err.code).toBe("max_tokens");
  });

  it("pause_turn resends the content unchanged with the same tools, then accumulates", async () => {
    const paused = [
      citedText("First ", "https://a.example/"),
      ...searchBlocks("s1", []),
      { type: "server_tool_use", id: "s2", name: "web_search", input: { query: "next" } },
    ];
    const { promise, requests } = run([
      message({
        stop_reason: "pause_turn",
        content: paused,
        usage: { input_tokens: 1, output_tokens: 2, server_tool_use: { web_search_requests: 2 } },
      }),
      message({
        content: [citedText("second.", "https://b.example/")],
        usage: { input_tokens: 3, output_tokens: 4, server_tool_use: { web_search_requests: 1 } },
      }),
    ]);
    const result = await promise;
    expect(requests).toHaveLength(2);
    const [first, second] = [requests[0]!.body, requests[1]!.body];
    expect(second.tools).toEqual(first.tools);
    expect(second.messages).toEqual([
      { role: "user", content: "find" },
      { role: "assistant", content: paused },
    ]);
    expect(second.messages).toHaveLength(2);
    expect(result.text).toBe("First second.");
    expect(result.searchCount).toBe(3);
    expect(result.usage.input_tokens).toBe(4);
    expect(result.sources.map((s) => s.url)).toEqual(["https://a.example/", "https://b.example/"]);
  });

  it("caps pause_turn continuations", async () => {
    const { promise, requests } = run([message({ stop_reason: "pause_turn" })]);
    const err = await failure(promise);
    expect(err.code).toBe("api");
    expect(requests).toHaveLength(MAX_PAUSE_CONTINUATIONS + 1);
  });

  it("an unexpected stop reason is an error", async () => {
    const err = await failure(run([message({ stop_reason: "tool_use" })]).promise);
    expect(err.code).toBe("api");
  });
});

describe("runResearch search results", () => {
  const error = { type: "web_search_tool_result_error", error_code: "unavailable" };

  it("every search erroring fails, even though the model wrote an answer", async () => {
    const content = [
      ...searchBlocks("s1", error),
      { type: "text", text: "From memory", citations: null },
    ];
    const err = await failure(run([message({ content })]).promise);
    expect(err.code).toBe("search_error");
  });

  it("an empty list is no results, not an error", async () => {
    const content = [
      ...searchBlocks("s1", []),
      { type: "text", text: "Nothing found", citations: null },
    ];
    const result = await run([message({ content })]).promise;
    expect(result.text).toBe("Nothing found");
    expect(result.sources).toEqual([]);
  });

  it("a later error after a working search keeps the answer", async () => {
    const content = [
      ...searchBlocks("s1", [
        {
          type: "web_search_result",
          url: "https://a.example/",
          title: "A",
          encrypted_content: "x",
          page_age: null,
        },
      ]),
      ...searchBlocks("s2", { ...error, error_code: "max_uses_exceeded" }),
      citedText("Answer", "https://a.example/"),
    ];
    const result = await run([message({ content })]).promise;
    expect(result.text).toBe("Answer");
    expect(console.warn).toHaveBeenCalled();
  });

  it("an org with web search disabled gets a clear error from the 400", async () => {
    const body = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Web search is disabled for this organization.",
      },
    };
    const err = await failure(run([jsonResponse(body, 400)]).promise);
    expect(err.code).toBe("search_disabled");
    expect(err.userMessage).toMatch(/Web search is disabled/);
  });

  it("another 400 about the tool stays a plain API error", async () => {
    const body = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "tools.0: web_search max_uses must be positive",
      },
    };
    const err = await failure(run([jsonResponse(body, 400)]).promise);
    expect(err.code).toBe("api");
  });

  it("an account out of credits says so on screen", async () => {
    const body = {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API.",
      },
    };
    const err = await failure(run([jsonResponse(body, 400)]).promise);
    expect(err.code).toBe("api");
    expect(err.userMessage).toMatch(/out of credits/);
  });

  it.each([
    [
      "code_execution_tool_result",
      { type: "code_execution_tool_result", tool_use_id: "x", content: {} },
    ],
    [
      "bash_code_execution_tool_result",
      { type: "bash_code_execution_tool_result", tool_use_id: "x", content: {} },
    ],
    [
      "code_execution server_tool_use",
      { type: "server_tool_use", id: "x", name: "code_execution", input: {} },
    ],
    [
      "web_fetch server_tool_use",
      { type: "server_tool_use", id: "x", name: "web_fetch", input: {} },
    ],
    [
      "search called from code",
      {
        type: "server_tool_use",
        id: "x",
        name: "web_search",
        input: {},
        caller: { type: "code_execution_20260120", tool_id: "t" },
      },
    ],
  ])("rejects a response with %s", async (_name, block) => {
    const err = await failure(
      run([message({ content: [block, { type: "text", text: "t", citations: null }] })]).promise,
    );
    expect(err.code).toBe("api");
    expect(err.message).toMatch(/disallowed block/);
  });
});

describe("runResearch sources", () => {
  it("keeps cited http/https URLs only, deduped, with a title when any citation has one", async () => {
    const content = [
      citedText("a", "https://a.example/page", null),
      citedText("b", "https://a.example/page", "A title"),
      citedText("c", "http://b.example/", "B"),
      citedText("d", "javascript:alert(1)", "bad"),
      citedText("e", "ftp://c.example/", "bad"),
      citedText("f", "not a url", "bad"),
      {
        type: "text",
        text: "g",
        citations: [
          {
            type: "char_location",
            cited_text: "x",
            document_index: 0,
            document_title: null,
            start_char_index: 0,
            end_char_index: 1,
            file_id: null,
          },
        ],
      },
    ];
    const { sources } = await run([message({ content })]).promise;
    expect(sources).toEqual([
      { url: "https://a.example/page", title: "A title" },
      { url: "http://b.example/", title: "B" },
    ]);
  });

  it("reports the model that answered and logs it without content", async () => {
    const content = [
      {
        type: "fallback",
        from: { model: "claude-opus-5-5" },
        to: { model: "claude-opus-4-8" },
        trigger: { type: "refusal", category: null },
      },
      citedText("SECRET-CONTENT", "https://a.example/"),
    ];
    const result = await run([message({ model: "claude-opus-4-8", content })]).promise;
    expect(result.model).toBe("claude-opus-4-8");
    const log = vi.mocked(console.info).mock.calls.flat().join(" ");
    expect(log).toContain("model=claude-opus-4-8");
    expect(log).not.toContain("SECRET-CONTENT");
  });
});
