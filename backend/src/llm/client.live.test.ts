import { describe, expect, it } from "vitest";
import { anthropicApiKey } from "../config/env";
import { checkLlmKey } from "./client";

describe.skipIf(!anthropicApiKey())("checkLlmKey (live)", () => {
  it("reports the real key as ready, without printing it", { timeout: 30_000 }, async () => {
    const health = await checkLlmKey();
    expect(health).toMatchObject({ status: "ready" });
    expect(health.detail).not.toContain(anthropicApiKey());
  });
});
