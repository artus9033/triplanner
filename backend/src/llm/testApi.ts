import Anthropic from "@anthropic-ai/sdk";

/** Test helper: a real SDK client whose fetch serves canned replies and records the wire request. */
export type CapturedRequest = {
  url: string;
  headers: Headers;
  body: any;
};

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const message = (overrides: Record<string, unknown> = {}) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "ok", citations: null }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 0 } },
  ...overrides,
});

export type Reply =
  Response | Record<string, unknown> | ((signal: AbortSignal) => Promise<Response>);

/** A fetch that serves replies in order, repeating the last, and captures each request. */
export const fakeFetch = (replies: Reply[]) => {
  const requests: CapturedRequest[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
    if (typeof reply === "function") return reply(init?.signal as AbortSignal);
    if (reply instanceof Response) return reply.clone();
    return jsonResponse(reply);
  }) as typeof fetch;
  return { fetchFn, requests };
};

export const fakeClient = (replies: Reply[]) => {
  const { fetchFn, requests } = fakeFetch(replies);
  return { client: new Anthropic({ apiKey: "test-key", fetch: fetchFn }), requests };
};

/** A reply that only settles when the request's abort signal fires. */
export const hangUntilAborted = (signal: AbortSignal): Promise<Response> =>
  new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

export const searchBlocks = (id: string, content: unknown) => [
  { type: "server_tool_use", id, name: "web_search", input: { query: "q" } },
  { type: "web_search_tool_result", tool_use_id: id, content },
];

export const citedText = (text: string, url: string, title: string | null = "Title") => ({
  type: "text",
  text,
  citations: [
    { type: "web_search_result_location", url, title, cited_text: "c", encrypted_index: "e" },
  ],
});
