import { afterEach, describe, expect, it, vi } from "vitest";
import { APEX_MODEL } from "../config/llm";
import { checkLlmKey, setApexFetchForTest } from "./client";
import { fakeFetch, jsonResponse } from "./testApi";

afterEach(() => {
  setApexFetchForTest(null);
  vi.unstubAllEnvs();
});

const withModels = (ids: string[]) => jsonResponse({ data: ids.map((id) => ({ id })) });

describe("checkLlmKey", () => {
  it("is ready when the key works and the model is listed", async () => {
    const { fetchFn, requests } = fakeFetch([withModels([APEX_MODEL])]);
    setApexFetchForTest(fetchFn);
    expect(await checkLlmKey()).toMatchObject({ status: "ready" });
    expect(requests[0]?.url).toBe("https://api.callstack.ai/v1/models");
  });

  it("is degraded for a rejected key, a missing model, a server error or no network", async () => {
    const cases: [Response | (() => Promise<Response>), RegExp][] = [
      [jsonResponse({}, 401), /rejected/],
      [jsonResponse({}, 403), /permission/],
      [withModels(["other"]), /not available/],
      [jsonResponse({}, 500), /status 500/],
      [() => Promise.reject(new Error("offline")), /could not reach/],
    ];
    for (const [reply, detail] of cases) {
      setApexFetchForTest(fakeFetch([reply]).fetchFn);
      const health = await checkLlmKey();
      expect(health.status).toBe("degraded");
      expect(health.detail).toMatch(detail);
    }
  });

  it("is missing when no key is set, and never shows a key", async () => {
    vi.stubEnv("APEX_API_KEY", "");
    expect(await checkLlmKey()).toEqual({ status: "missing", detail: "APEX_API_KEY is not set" });
    vi.stubEnv("APEX_API_KEY", "sk-secret-value");
    setApexFetchForTest(fakeFetch([jsonResponse({}, 401)]).fetchFn);
    expect((await checkLlmKey()).detail).not.toContain("sk-secret-value");
  });
});
