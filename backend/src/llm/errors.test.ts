import { describe, expect, it } from "vitest";
import { LlmError, toLlmError } from "./errors";

describe("toLlmError", () => {
  it("passes an LlmError through", () => {
    const err = new LlmError("refusal");
    expect(toLlmError(err)).toBe(err);
  });

  it("maps statuses, and unwraps the SDK's retry error", () => {
    expect(toLlmError({ statusCode: 401, message: "x" }).userMessage).toMatch(/APEX_API_KEY/);
    expect(toLlmError({ statusCode: 429, message: "x" }).userMessage).toMatch(/busy/);
    const wrapped = { name: "AI_RetryError", lastError: { statusCode: 429, message: "x" } };
    expect(toLlmError(wrapped).userMessage).toMatch(/busy/);
  });

  it("maps aborts to timeout", () => {
    expect(toLlmError(new DOMException("a", "AbortError")).code).toBe("timeout");
    expect(toLlmError(new Error("x"), AbortSignal.abort()).code).toBe("timeout");
  });

  it("keeps API detail and keys off the screen and out of logs", () => {
    const err = toLlmError({ statusCode: 500, message: "boom for sk-v1aZ9OzWabc" });
    expect(err.userMessage).not.toMatch(/boom|sk-/);
    expect(err.message).toContain("[redacted]");
    expect(err.message).not.toContain("sk-v1aZ9OzWabc");
  });
});
