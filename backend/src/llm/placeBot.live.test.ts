import { emptyTripState, PlaceDataSchema, type TripState } from "@triplanner/shared";
import { describe, expect, it } from "vitest";
import { apexApiKey } from "../config/env";
import { BOT_TIME_BUDGET_MS } from "../config/optimizer";
import { researchPlace } from "./placeBot";

const state: TripState = {
  ...emptyTripState(),
  city: "Paris",
  start_date: "2026-11-19",
  end_date: "2026-11-21",
};

describe.skipIf(!apexApiKey())("researchPlace (live)", () => {
  it("reports a place shut for renovation as closed", { timeout: 90_000 }, async () => {
    const { data } = await researchPlace({ name: "Centre Pompidou", note: null, state });
    console.info(`[live] Pompidou closed=${data.closed_during_trip} hours=${data.hours.length}`);
    expect(data.closed_during_trip).toBe(true);
    expect(data.hours).toEqual([]);
  });

  it("researches the Louvre on real pages inside the budget", { timeout: 90_000 }, async () => {
    const result = await researchPlace({ name: "Louvre Museum", note: null, state });
    console.info(
      `[live] Louvre ms=${result.durationMs} usage=${JSON.stringify(result.usage)} ` +
        `sources=${result.sources.map((s) => s.url).join(" ")}\n` +
        `[live] hours=${JSON.stringify(result.data.hours)} tickets=${JSON.stringify(result.data.tickets)}`,
    );
    expect(result.durationMs).toBeLessThan(BOT_TIME_BUDGET_MS);
    expect(PlaceDataSchema.safeParse(result.data).success).toBe(true);
    expect(result.data.place).toMatch(/louvre/i);
    expect(result.data.category).toBe("museum");
    expect(Math.abs((result.data.lat ?? 0) - 48.86)).toBeLessThan(0.1);
    for (const { date } of result.data.hours) {
      expect(["2026-11-19", "2026-11-20", "2026-11-21"]).toContain(date);
    }
    expect(result.sources.length).toBeGreaterThan(0);
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//);
  });
});
