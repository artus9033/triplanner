import { emptyTripState, PlaceProposalSchema, type TripState } from "@triplanner/shared";
import { describe, expect, it } from "vitest";
import { llmApiKey } from "../config/env";
import { isSamePlaceName, proposePlaces } from "./proposals";

const state: TripState = {
  ...emptyTripState(),
  city: "Paris",
  start_date: "2026-11-19",
  end_date: "2026-11-20",
  plans: "the Louvre and a few modern art galleries",
  named_places: [{ name: "Louvre", note: null }],
  needs_search: true,
  budget_answered: true,
};

describe.skipIf(!llmApiKey())("proposePlaces (live)", () => {
  it("proposes valid options with one safe link", { timeout: 120_000 }, async () => {
    const startedAt = Date.now();
    const proposals = await proposePlaces({ state, messages: [], maxFetches: 1 });
    console.info(
      `[live] proposals ms=${Date.now() - startedAt} ${proposals.map((p) => p.name).join(" | ")}`,
    );
    expect(proposals.length).toBeGreaterThan(0);
    for (const proposal of proposals) {
      expect(PlaceProposalSchema.safeParse(proposal).success).toBe(true);
      expect(isSamePlaceName(proposal.name, "Louvre")).toBe(false);
      expect(proposal.link).toMatch(/^https:\/\/www\.google\.com\/maps\/search\//);
    }
  });
});
