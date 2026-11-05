import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_MODEL } from "../config/llm";
import { checkLlmKey, getAnthropicClient, setAnthropicClientForTest } from "./client";
import { fakeClient, jsonResponse } from "./testApi";

const apiError = (type: string, msg: string) => ({ type: "error", error: { type, message: msg } });

afterEach(() => {
  setAnthropicClientForTest(null);
  vi.unstubAllEnvs();
});

describe("checkLlmKey", () => {
  it("is ready when the Models API knows the model, and spends no tokens", async () => {
    const { client, requests } = fakeClient([
      jsonResponse({
        id: CLAUDE_MODEL,
        type: "model",
        display_name: "x",
        created_at: "2026-01-01T00:00:00Z",
      }),
    ]);
    setAnthropicClientForTest(client);
    expect((await checkLlmKey()).status).toBe("ready");
    expect(requests[0]!.url).toContain(`/v1/models/${CLAUDE_MODEL}`);
  });

  it("is degraded when the key is rejected, and does not leak it", async () => {
    const { client } = fakeClient([
      jsonResponse(apiError("authentication_error", "invalid x-api-key"), 401),
    ]);
    setAnthropicClientForTest(client);
    const health = await checkLlmKey();
    expect(health.status).toBe("degraded");
    expect(health.detail).not.toContain("test-key");
  });

  it("is missing when no key is set, and getAnthropicClient throws no_key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_API_KEY", "");
    expect((await checkLlmKey()).status).toBe("missing");
    expect(() => getAnthropicClient()).toThrowError(expect.objectContaining({ code: "no_key" }));
  });
});
