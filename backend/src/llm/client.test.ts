import { afterEach, describe, expect, it, vi } from "vitest";
import { llmApiKey, llmBaseUrl, llmModelId } from "../config/env";
import { APEX_BASE_URL, APEX_MODEL } from "../config/llm";
import { checkLlmKey, setApexFetchForTest } from "./client";
import { fakeFetch, jsonResponse } from "./testApi";

afterEach(() => {
  setApexFetchForTest(null);
  vi.unstubAllEnvs();
});

const withModels = (ids: string[]) => jsonResponse({ data: ids.map((id) => ({ id })) });

describe("LLM connector settings", () => {
  it("defaults to Apex when the base URL and model are not set", () => {
    vi.stubEnv("LLM_BASE_URL", "");
    vi.stubEnv("LLM_MODEL", "");
    expect(llmBaseUrl()).toBe(APEX_BASE_URL);
    expect(llmModelId()).toBe(APEX_MODEL);
  });

  it("prefers LLM_API_KEY and still accepts APEX_API_KEY", () => {
    vi.stubEnv("LLM_API_KEY", "new");
    vi.stubEnv("APEX_API_KEY", "old");
    expect(llmApiKey()).toBe("new");
    vi.stubEnv("LLM_API_KEY", "");
    expect(llmApiKey()).toBe("old");
  });
});

describe("checkLlmKey", () => {
  it("is ready when the key works and the model is listed", async () => {
    vi.stubEnv("LLM_BASE_URL", "https://llm.example/v1");
    vi.stubEnv("LLM_MODEL", "some-model");
    const { fetchFn, requests } = fakeFetch([withModels(["some-model"])]);
    setApexFetchForTest(fetchFn);
    expect(await checkLlmKey()).toMatchObject({ status: "ready" });
    expect(requests[0]?.url).toBe("https://llm.example/v1/models");
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
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("APEX_API_KEY", "");
    expect(await checkLlmKey()).toEqual({ status: "missing", detail: "LLM_API_KEY is not set" });
    vi.stubEnv("LLM_API_KEY", "sk-secret-value");
    setApexFetchForTest(fakeFetch([jsonResponse({}, 401)]).fetchFn);
    expect((await checkLlmKey()).detail).not.toContain("sk-secret-value");
  });
});
