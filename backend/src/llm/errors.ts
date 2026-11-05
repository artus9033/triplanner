/** Why a Claude call failed. `userMessage` is shown on screen, so it never carries API detail. */
export type LlmErrorCode =
  | "refusal"
  | "max_tokens"
  | "search_error"
  | "search_disabled"
  | "timeout"
  | "extract_failed"
  | "no_key"
  | "api";

const DEFAULT_MESSAGES: Record<LlmErrorCode, string> = {
  refusal: "Claude declined this request, so there is no result. You can retry.",
  max_tokens:
    "Claude's answer was cut off because it ran too long, so it was not saved. You can retry.",
  search_error: "Web search failed, so there is no reliable result. You can retry in a moment.",
  search_disabled:
    "Web search is disabled for this Claude organization. An administrator can enable it in the Claude Console.",
  timeout: "This took longer than the time allowed and was stopped. You can retry.",
  extract_failed: "Claude's answer could not be turned into valid data. You can retry.",
  no_key: "No Claude API key is set. Add ANTHROPIC_API_KEY to .env and restart the app.",
  api: "The Claude API returned an error. You can retry in a moment.",
};

const redact = (text: string): string => text.replace(/sk-ant-[\w-]+/g, "[redacted]");

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly userMessage: string;

  /** `detail` goes in `message`, for logs. `userMessage` falls back to a plain text per code. */
  constructor(
    code: LlmErrorCode,
    options: { userMessage?: string; detail?: string; cause?: unknown } = {},
  ) {
    super(redact(options.detail ?? options.userMessage ?? DEFAULT_MESSAGES[code]), {
      cause: options.cause,
    });
    this.name = "LlmError";
    this.code = code;
    this.userMessage = options.userMessage ?? DEFAULT_MESSAGES[code];
  }
}

const apiMessage = (err: Record<string, unknown>): string => {
  const body = err.error as { error?: { message?: unknown } } | undefined;
  const nested = body?.error?.message;
  return typeof nested === "string" ? nested : String(err.message ?? "");
};

/** A 400 whose text says web search is off. The API documents no dedicated error type for it. */
export const isWebSearchDisabledMessage = (message: string): boolean =>
  /web[_ ]?search/i.test(message) &&
  /disabled|not enabled|not been enabled|not allowed|not permitted|turned off/i.test(message);

/**
 * Maps anything thrown by an SDK call to an LlmError. Duck-typed, because @langchain/anthropic
 * brings its own copy of the SDK and `instanceof` would miss its error classes.
 */
export const toLlmError = (err: unknown, signal?: AbortSignal): LlmError => {
  if (err instanceof LlmError) return err;
  const e = (typeof err === "object" && err !== null ? err : {}) as Record<string, unknown>;
  const name = String(e.name ?? (err as object | undefined)?.constructor?.name ?? "");
  const className = String((err as object | undefined)?.constructor?.name ?? "");
  const isAbort = [name, className].some((n) =>
    ["AbortError", "APIUserAbortError", "APIConnectionTimeoutError"].includes(n),
  );
  if (signal?.aborted || isAbort) return new LlmError("timeout", { cause: err });

  const status = typeof e.status === "number" ? e.status : undefined;
  const detail = apiMessage(e);
  if (status === undefined) return new LlmError("api", { detail, cause: err });
  if (status === 400 && isWebSearchDisabledMessage(detail)) {
    return new LlmError("search_disabled", { detail, cause: err });
  }
  if (status === 400 && /credit balance/i.test(detail)) {
    return new LlmError("api", {
      userMessage:
        "The Claude account is out of credits. Add credits in the Claude Console, then retry.",
      detail,
      cause: err,
    });
  }
  if (status === 401) {
    return new LlmError("api", {
      userMessage: "The Claude API key was rejected. Check ANTHROPIC_API_KEY in .env.",
      detail,
      cause: err,
    });
  }
  if (status === 429 || status === 529) {
    return new LlmError("api", {
      userMessage: "The Claude API is busy right now. You can retry in a moment.",
      detail,
      cause: err,
    });
  }
  return new LlmError("api", { detail: `status ${status}: ${detail}`, cause: err });
};
