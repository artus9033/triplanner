import { emptyTripState, PlaceProposalSchema, type TripState } from "@triplanner/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setApexFetchForTest } from "./client";
import type { fetchPage } from "./fetchPage";
import { isSamePlaceName, proposePlaces } from "./proposals";
import { setPageFetcherForTest } from "./research";
import { chat, fakeFetch, fetchCall, type Reply } from "./testApi";

const state: TripState = {
  ...emptyTripState(),
  city: "Paris",
  start_date: "2026-12-01",
  end_date: "2026-12-02",
  plans: "Louvre and modern galleries",
  named_places: [{ name: "Louvre", note: null }],
  needs_search: true,
  budget_answered: true,
};

const place = (name: string) => ({ name, category: "gallery", why: "Fits." });

const run = (replies: Reply[]) => {
  const fake = fakeFetch(replies);
  setApexFetchForTest(fake.fetchFn);
  return {
    requests: fake.requests,
    result: proposePlaces({
      state,
      messages: [{ id: "1", role: "user", content: "I love modern art", createdAt: "" }],
    }),
  };
};

beforeEach(() =>
  setPageFetcherForTest((async (url: string) => ({
    url,
    title: "Guide",
    text: "text",
  })) as unknown as typeof fetchPage),
);
afterEach(() => {
  setApexFetchForTest(null);
  setPageFetcherForTest(null);
});

describe("proposePlaces", () => {
  it("attaches ids, exactly one maps link built in code, and only pages that loaded", async () => {
    const { requests, result } = run([
      fetchCall("https://guide.example/"),
      chat({ content: "Centre Pompidou and Palais de Tokyo." }),
      chat({ content: JSON.stringify({ places: [place("Centre Pompidou")] }) }),
    ]);
    const [first, ...rest] = await result;
    expect(rest).toEqual([]);
    expect(PlaceProposalSchema.safeParse(first).success).toBe(true);
    expect(first!.id).toBeTruthy();
    expect(first!.link).toBe(
      "https://www.google.com/maps/search/?api=1&query=Centre%20Pompidou%2C%20Paris",
    );
    expect(first!.link_kind).toBe("google_maps");
    expect(first!.sources).toEqual([{ url: "https://guide.example/", title: "Guide" }]);
    expect(requests.at(-1)!.body.tools).toBeUndefined();
    expect(JSON.stringify(requests[0]!.body.messages)).toContain("I love modern art");
  });

  it("works without any page, because step 2 verifies each chosen place", async () => {
    const { result } = run([
      chat({ content: "Centre Pompidou." }),
      chat({ content: JSON.stringify({ places: [place("Centre Pompidou")] }) }),
    ]);
    expect((await result)[0]!.sources).toEqual([]);
  });

  it("removes named places and duplicates", async () => {
    const { result } = run([
      chat({ content: "notes" }),
      chat({
        content: JSON.stringify({
          places: [place("The Louvre Museum"), place("Pompidou"), place("Centre Pompidou")],
        }),
      }),
    ]);
    expect((await result).map((p) => p.name)).toEqual(["Pompidou"]);
  });

  it("passes on model failures", async () => {
    await expect(run([chat({ finish: "content_filter" })]).result).rejects.toMatchObject({
      code: "refusal",
    });
    await expect(
      run([chat({ content: "notes" }), chat({ content: "not json" })]).result,
    ).rejects.toMatchObject({ code: "extract_failed" });
  });
});

describe("isSamePlaceName", () => {
  it.each([
    ["Louvre", "The Louvre Museum", true],
    ["Musée d'Orsay", "Orsay", true],
    ["Louvre", "Orsay", false],
    ["", "Louvre", false],
  ])("%s / %s → %s", (a, b, same) => expect(isSamePlaceName(a, b)).toBe(same));
});
