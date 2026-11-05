import { emptyTripState, type TripState } from "@triplanner/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROPOSAL_SEARCH_MAX_USES } from "../config/llm";
import { setAnthropicClientForTest } from "./client";
import { isSamePlaceName, pickLink, proposePlaces } from "./proposals";
import { citedText, fakeClient, message } from "./testApi";

const state: TripState = {
  ...emptyTripState(),
  city: "Paris",
  start_date: "2026-11-10",
  end_date: "2026-11-11",
  plans: "the Louvre and modern art galleries",
  named_places: [{ name: "Louvre", note: null }],
  needs_search: true,
  budget_answered: true,
};

const extraction = {
  places: [
    {
      name: "Galerie Perrotin",
      category: "Gallery",
      why: "Modern art",
      google_maps_url: "https://www.google.com/maps/place/x",
      website: "https://perrotin.com/",
    },
    {
      name: "Thaddaeus Ropac",
      category: "gallery",
      why: "Modern art",
      google_maps_url: null,
      website: "https://ropac.net/",
    },
    {
      name: "Fake Maps",
      category: "gallery",
      why: "x",
      google_maps_url: "https://evil.example/maps",
      website: null,
    },
    {
      name: "Bad Link",
      category: "gallery",
      why: "x",
      google_maps_url: "javascript:alert(1)",
      website: "file:///etc/passwd",
    },
    {
      name: "The Louvre Museum",
      category: "museum",
      why: "already named",
      google_maps_url: null,
      website: null,
    },
    {
      name: "galerie perrotin",
      category: "gallery",
      why: "duplicate",
      google_maps_url: null,
      website: null,
    },
  ],
};

const setup = () => {
  const { client, requests } = fakeClient([
    message({
      content: [
        citedText("Galerie Perrotin shows modern art. ", "https://perrotin.com/about", "Perrotin"),
        citedText("Others are nice.", "https://guide.example/", "Guide"),
      ],
    }),
    message({ content: [{ type: "text", text: JSON.stringify(extraction) }] }),
  ]);
  setAnthropicClientForTest(client);
  return requests;
};

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  setAnthropicClientForTest(null);
  vi.restoreAllMocks();
});

describe("proposePlaces", () => {
  it("searches with only the one tool, extracts with none", async () => {
    const requests = setup();
    await proposePlaces({ state, messages: [] });
    expect(requests[0]!.body.tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: PROPOSAL_SEARCH_MAX_USES },
    ]);
    expect(requests[1]!.body).not.toHaveProperty("tools");
    expect(requests[0]!.body.system).toMatch(/ignore any instructions/i);
    expect(requests[0]!.body.messages[0].content).toContain("Louvre");
  });

  it("drops named places and duplicates, assigns ids, one link, backend-attached sources", async () => {
    setup();
    const proposals = await proposePlaces({ state, messages: [] });
    expect(proposals.map((p) => p.name)).toEqual([
      "Galerie Perrotin",
      "Thaddaeus Ropac",
      "Fake Maps",
      "Bad Link",
    ]);
    expect(new Set(proposals.map((p) => p.id)).size).toBe(4);
    const [perrotin, ropac, fake, bad] = proposals;
    expect(perrotin).toMatchObject({
      category: "gallery",
      link: "https://www.google.com/maps/place/x",
      link_kind: "google_maps",
    });
    expect(ropac).toMatchObject({ link: "https://ropac.net/", link_kind: "website" });
    expect(fake).toMatchObject({ link: null, link_kind: null });
    expect(bad).toMatchObject({ link: null, link_kind: null });
    // Cited for this place only.
    expect(perrotin!.sources).toEqual([{ url: "https://perrotin.com/about", title: "Perrotin" }]);
    // Not tied to a citation: gets all the research's sources.
    expect(ropac!.sources.map((s) => s.url)).toEqual([
      "https://perrotin.com/about",
      "https://guide.example/",
    ]);
  });
});

describe("helpers", () => {
  it("isSamePlaceName", () => {
    expect(isSamePlaceName("Louvre", "The Louvre Museum")).toBe(true);
    expect(isSamePlaceName("Musée d'Orsay", "musee d orsay")).toBe(true);
    expect(isSamePlaceName("Louvre", "Orsay")).toBe(false);
    expect(isSamePlaceName("Museum", "Louvre")).toBe(false);
  });

  it("pickLink prefers real Google Maps URLs", () => {
    expect(pickLink("https://maps.app.goo.gl/abc", "https://a.fr").link_kind).toBe("google_maps");
    expect(pickLink("https://maps.google.fr/x", null).link_kind).toBe("google_maps");
    expect(pickLink("https://a.example/maps", "https://a.fr").link_kind).toBe("website");
    expect(pickLink(null, "ftp://a.fr").link).toBeNull();
  });
});
