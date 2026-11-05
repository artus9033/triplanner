/** Why an Apex call failed. `userMessage` is shown on screen, so it never carries API detail. */
export type LlmErrorCode =
  "refusal" | "max_tokens" | "no_pages" | "timeout" | "extract_failed" | "no_key" | "api";

const DEFAULT_MESSAGES: Record<LlmErrorCode, string> = {
  refusal: "The AI model declined this request, so there is no result. You can retry.",
  max_tokens:
    "The AI model's answer was cut off because it ran too long, so it was not saved. You can retry.",
  no_pages:
    "No web page about this place could be loaded, so its hours and prices could not be checked. You can retry.",
  timeout: "This took longer than the time allowed and was stopped. You can retry.",
  extract_failed: "The AI model's answer could not be turned into valid data. You can retry.",
  no_key: "No Apex API key is set. Add APEX_API_KEY to .env and restart the app.",
  api: "The Apex API returned an error. You can retry in a moment.",
};

const redact = (text: string): string => text.replace(/\bsk-[\w-]{8,}/g, "[redacted]");

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

/** Maps anything thrown by an AI SDK call to an LlmError. Retries wrap the real error. */
export const toLlmError = (err: unknown, signal?: AbortSignal): LlmError => {
  if (err instanceof LlmError) return err;
  const outer = (typeof err === "object" && err !== null ? err : {}) as Record<string, unknown>;
  const e = (outer.lastError ?? outer) as Record<string, unknown>;
  if (signal?.aborted || e.name === "AbortError" || e.name === "TimeoutError") {
    return new LlmError("timeout", { cause: err });
  }
  const detail = String(e.message ?? "");
  const status = typeof e.statusCode === "number" ? e.statusCode : undefined;
  if (status === 401 || status === 403) {
    return new LlmError("api", {
      userMessage: "The Apex API key was rejected. Check APEX_API_KEY in .env.",
      detail,
      cause: err,
    });
  }
  if (status === 429 || status === 529) {
    return new LlmError("api", {
      userMessage: "The Apex API is busy right now. You can retry in a moment.",
      detail,
      cause: err,
    });
  }
  return new LlmError("api", {
    detail: status === undefined ? detail : `status ${status}: ${detail}`,
    cause: err,
  });
};

/**
 * For calls that ask for JSON. The SDK raises its own error when the output cannot be parsed, and
 * that error carries the finish reason: a refused or cut-off answer is not a parsing problem.
 */
export const structuredOutputError = (err: unknown, signal?: AbortSignal): LlmError => {
  const { name, finishReason } = (err ?? {}) as { name?: string; finishReason?: string };
  if (name === "AI_NoObjectGeneratedError" || name === "AI_NoOutputGeneratedError") {
    if (finishReason === "content-filter") return new LlmError("refusal", { cause: err });
    if (finishReason === "length") return new LlmError("max_tokens", { cause: err });
    return new LlmError("extract_failed", { detail: "the model returned no valid JSON" });
  }
  if (name === "ZodError") {
    return new LlmError("extract_failed", { detail: "the output failed validation" });
  }
  return toLlmError(err, signal);
};
