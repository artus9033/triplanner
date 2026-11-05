import { emptyTripState, PlaceDataSchema, type TripState } from "@triplanner/shared";
import { describe, expect, it } from "vitest";
import { anthropicApiKey } from "../config/env";
import { BOT_TIME_BUDGET_MS } from "../config/optimizer";
import { researchPlace } from "./placeBot";

const state: TripState = {
  ...emptyTripState(),
  city: "Paris",
  start_date: "2026-11-19",
  end_date: "2026-11-21",
};

describe.skipIf(!anthropicApiKey())("researchPlace (live)", () => {
  it("researches the Louvre inside the budget", { timeout: 90_000 }, async () => {
    const result = await researchPlace({ name: "Louvre Museum", note: null, state, maxUses: 2 });
    console.info(
      `[live] Louvre maxUses=2 ms=${result.durationMs} cost_usd=${result.costUsd.toFixed(4)} model=${result.model} usage=${JSON.stringify(result.usage)}`,
    );
    expect(result.durationMs).toBeLessThan(BOT_TIME_BUDGET_MS);
    expect(PlaceDataSchema.safeParse(result.data).success).toBe(true);
    expect(result.data.place).toMatch(/louvre/i);
    expect(result.data.category).toBe("museum");
    expect(result.data.lat === null || Math.abs(result.data.lat - 48.86) < 0.1).toBe(true);
    for (const { date } of result.data.hours) {
      expect(["2026-11-19", "2026-11-20", "2026-11-21"]).toContain(date);
    }
    expect(result.sources.length).toBeGreaterThan(0);
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//);
  });
});
