import { emptyTripState, PlaceProposalSchema, type TripState } from "@triplanner/shared";
import { describe, expect, it } from "vitest";
import { anthropicApiKey } from "../config/env";
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

describe.skipIf(!anthropicApiKey())("proposePlaces (live)", () => {
  it(
    "proposes real options with one safe link and backend sources",
    { timeout: 120_000 },
    async () => {
      const startedAt = Date.now();
      const proposals = await proposePlaces({ state, messages: [], maxUses: 2 });
      console.info(`[live] proposals n=${proposals.length} ms=${Date.now() - startedAt}`);
      expect(proposals.length).toBeGreaterThan(0);
      for (const proposal of proposals) {
        expect(PlaceProposalSchema.safeParse(proposal).success).toBe(true);
        expect(isSamePlaceName(proposal.name, "Louvre")).toBe(false);
        expect(proposal.sources.length).toBeGreaterThan(0);
        if (proposal.link) expect(proposal.link).toMatch(/^https?:\/\//);
        expect(proposal.link === null).toBe(proposal.link_kind === null);
      }
    },
  );
});
