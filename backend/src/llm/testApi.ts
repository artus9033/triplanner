/** Test helper: the real AI SDK against a fetch that serves canned replies and records requests. */
export type CapturedRequest = { url: string; headers: Headers; body: any };

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

type ToolCall = { id?: string; name: string; args: unknown };

export const chat = ({
  content = "ok",
  toolCalls,
  finish,
}: { content?: string | null; toolCalls?: ToolCall[]; finish?: string } = {}) => ({
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1,
  model: "callstack/Apex",
  choices: [
    {
      index: 0,
      finish_reason: finish ?? (toolCalls ? "tool_calls" : "stop"),
      message: {
        role: "assistant",
        content,
        ...(toolCalls && {
          tool_calls: toolCalls.map((call, i) => ({
            id: call.id ?? `call_${i}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        }),
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

export const fetchCall = (url: string, id?: string) =>
  chat({ content: null, toolCalls: [{ id, name: "fetch_page", args: { url } }] });

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

/** A reply that only settles when the request's abort signal fires. */
export const hangUntilAborted = (signal: AbortSignal): Promise<Response> =>
  new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
