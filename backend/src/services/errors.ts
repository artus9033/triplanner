export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Text safe to show on screen. LlmError carries its own; anything else stays generic. */
export const userMessageOf = (err: unknown, fallback: string): string => {
  if (err instanceof HttpError) return err.message;
  const message = (err as { userMessage?: unknown } | null)?.userMessage;
  return typeof message === "string" && message ? message : fallback;
};
