import {
  ApiErrorSchema,
  SpeechStatusSchema,
  TripSchema,
  TripSummarySchema,
  type OptimizeRequest,
  type SpeechStatus,
  type Trip,
  type TripSummary,
} from "@triplanner/shared";

/** A failed API call. `message` is safe and meant to be shown on screen. */
export class ApiRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

interface Parser<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

type UnauthorizedHandler = () => Promise<void>;
let onUnauthorized: UnauthorizedHandler | null = null;

/**
 * The access gate registers here. A 401 then waits until the handler resolves (the password was
 * accepted) and re-sends the request, so nothing the user did is lost. The gate rejects a request
 * before it runs, which makes replaying a POST safe.
 */
export const setUnauthorizedHandler = (handler: UnauthorizedHandler | null): void => {
  onUnauthorized = handler;
};

const errorFrom = async (res: Response): Promise<ApiRequestError> => {
  let text = "";
  try {
    text = await res.text();
  } catch {
    // The status alone still produces a message below.
  }
  try {
    const parsed = ApiErrorSchema.safeParse(JSON.parse(text));
    if (parsed.success) return new ApiRequestError(parsed.data.error, res.status);
  } catch {
    // Not JSON, for example an HTML error page from the dev proxy when the backend is down.
  }
  return new ApiRequestError(`The server answered with an error (HTTP ${res.status}).`, res.status);
};

const send = async (path: string, init: RequestInit = {}, gated = true): Promise<Response> => {
  for (;;) {
    let res: Response;
    try {
      res = await fetch(`/api${path}`, init);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new ApiRequestError(`Could not reach the server: ${detail}`, 0);
    }
    if (res.status === 401 && gated && onUnauthorized) {
      await onUnauthorized();
      continue;
    }
    if (!res.ok) throw await errorFrom(res);
    return res;
  }
};

const parse = async <T>(res: Response, schema: Parser<T>, path: string): Promise<T> => {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiRequestError(`The server sent an unreadable response for ${path}.`, res.status);
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue ? `${issue.path.map(String).join(".") || "body"}: ${issue.message}` : "";
  throw new ApiRequestError(
    `The server sent an unexpected response for ${path} (${where}).`,
    res.status,
  );
};

const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const tripCall = async (path: string, init?: RequestInit): Promise<Trip> =>
  parse(await send(path, init), TripSchema, path);

const tripPath = (id: string): string => `/trips/${encodeURIComponent(id)}`;

const TripSummaryListSchema = TripSummarySchema.array();

const TranscriptParser: Parser<{ text: string }> = {
  safeParse(value) {
    const text = (value as { text?: unknown } | null)?.text;
    return typeof text === "string"
      ? { success: true, data: { text } }
      : { success: false, error: { issues: [{ path: ["text"], message: "expected a string" }] } };
  },
};

export const api = {
  listTrips: async (): Promise<TripSummary[]> =>
    parse(await send("/trips"), TripSummaryListSchema, "/trips"),
  createTrip: (): Promise<Trip> => tripCall("/trips", { method: "POST" }),
  getTrip: (id: string): Promise<Trip> => tripCall(tripPath(id)),
  deleteTrip: async (id: string): Promise<void> => {
    await send(tripPath(id), { method: "DELETE" });
  },
  sendMessage: (id: string, content: string): Promise<Trip> =>
    tripCall(`${tripPath(id)}/messages`, postJson({ content })),
  retryProposals: (id: string): Promise<Trip> =>
    tripCall(`${tripPath(id)}/proposals/retry`, { method: "POST" }),
  confirmProposals: (id: string, placeIds: string[]): Promise<Trip> =>
    tripCall(`${tripPath(id)}/proposals/confirm`, postJson({ placeIds })),
  retryPlace: (id: string, placeId: string): Promise<Trip> =>
    tripCall(`${tripPath(id)}/places/${encodeURIComponent(placeId)}/retry`, { method: "POST" }),
  optimize: (id: string, request: OptimizeRequest): Promise<Trip> =>
    tripCall(`${tripPath(id)}/optimize`, postJson(request)),
  finalize: (id: string): Promise<Trip> => tripCall(`${tripPath(id)}/finalize`, { method: "POST" }),

  speechStatus: async (): Promise<SpeechStatus> =>
    parse(await send("/speech/status"), SpeechStatusSchema, "/speech/status"),
  transcribe: async (wav: Blob): Promise<string> => {
    const res = await send("/speech/transcribe", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
    });
    return (await parse(res, TranscriptParser, "/speech/transcribe")).text;
  },
  tts: async (text: string): Promise<Blob> =>
    (await send("/speech/tts", postJson({ text }))).blob(),

  /** Never waits on the gate: a wrong password has to surface as an error. */
  auth: async (password: string): Promise<void> => {
    await send("/auth", postJson({ password }), false);
  },
};

export const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
