import {
  emptyTripState,
  PlaceDataSchema,
  type PlaceData,
  type TripState,
} from "@triplanner/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApexFetchForTest } from "./client";
import { PageError, type fetchPage } from "./fetchPage";
import { setGeocodeFetchForTest } from "./geocode";
import { postValidatePlace, researchPlace, withBudget } from "./placeBot";
import { setPageFetcherForTest } from "./research";
import { chat, fakeFetch, fetchCall, hangUntilAborted, jsonResponse, type Reply } from "./testApi";

const state: TripState = {
  ...emptyTripState(),
  city: "Paris",
  start_date: "2026-12-01",
  end_date: "2026-12-02",
};

const data: PlaceData = {
  closed_during_trip: false,
  place: "Louvre",
  category: "museum",
  address: "Rue de Rivoli",
  lat: null,
  lng: null,
  phone: null,
  website: "https://www.louvre.fr",
  hours: [{ date: "2026-12-01", start: "09:00", end: "18:00" }],
  description: "Big museum",
  visit_duration_min: null,
  google_place_id: null,
  google_maps_url: null,
  place_image_url: null,
  tickets: [{ type: "paid", price: "22EUR", condition: null }],
  needs_reservation: true,
};

let geocode: ReturnType<typeof fakeFetch>;
const SITE = "https://www.louvre.fr/hours";

const run = (replies: Reply[], options: { budgetMs?: number } = {}) => {
  const fake = fakeFetch(replies);
  setApexFetchForTest(fake.fetchFn);
  return {
    requests: fake.requests,
    result: researchPlace({ name: "Louvre", note: "Richelieu wing", state, ...options }),
  };
};
const happy = (value: unknown = data): Reply[] => [
  fetchCall(SITE),
  chat({ content: "Hours are on the site." }),
  chat({ content: JSON.stringify(value) }),
];

beforeEach(() => {
  geocode = fakeFetch([jsonResponse([{ lat: "48.86", lon: "2.33" }])]);
  setGeocodeFetchForTest(geocode.fetchFn);
  setPageFetcherForTest((async (url: string) => ({
    url,
    title: "Hours",
    text: "PAGE-TEXT: open 9 to 18, 22 euros",
  })) as unknown as typeof fetchPage);
});
afterEach(() => {
  setApexFetchForTest(null);
  setPageFetcherForTest(null);
  setGeocodeFetchForTest(null);
});

describe("researchPlace", () => {
  it("researches, extracts, geocodes and attaches real sources", async () => {
    const { result } = run(happy());
    const out = await result;
    expect(PlaceDataSchema.safeParse(out.data).success).toBe(true);
    expect(out.sources).toEqual([{ url: SITE, title: "Hours" }]);
    expect(out.model).toBe("callstack/Apex");
    expect(out.data).toMatchObject({ lat: 48.86, lng: 2.33 });
    expect(out.data.google_maps_url).toContain("google.com/maps/search");
    expect(out.data.google_maps_url).toContain("Louvre%2C%20Paris");
  });

  it("extracts from the page text alone, never the model's notes, and with no tools", async () => {
    const { requests, result } = run([
      fetchCall(SITE),
      chat({ content: "MODEL-MEMORY: open until midnight" }),
      chat({ content: JSON.stringify(data) }),
    ]);
    await result;
    const extract = requests.at(-1)!.body;
    expect(extract.tools).toBeUndefined();
    const sent = JSON.stringify(extract.messages);
    expect(sent).toContain("PAGE-TEXT");
    expect(sent).not.toContain("MODEL-MEMORY");
    expect(extract.messages[0].content).toMatch(/never your own knowledge/);
  });

  it("states the budget, dates, and that web text is untrusted, in the prompts", async () => {
    const { requests, result } = run(happy());
    await result;
    const [first] = requests;
    const text = JSON.stringify(first!.body.messages);
    expect(text).toMatch(/tops 1 minute/);
    expect(text).toMatch(/untrusted/);
    expect(text).toContain("2026-12-01 (Tuesday)");
    expect(text).toContain("Richelieu wing");
  });

  it("fails visibly when no page loaded, however confident the model sounds", async () => {
    setPageFetcherForTest((async () => {
      throw new PageError("The page returned status 403.");
    }) as unknown as typeof fetchPage);
    const { requests, result } = run([
      fetchCall(SITE),
      chat({ content: "From memory, the Louvre opens at 9." }),
    ]);
    await expect(result).rejects.toMatchObject({ code: "no_pages" });
    expect(requests).toHaveLength(2);
  });

  it("also fails when the model never fetches anything", async () => {
    await expect(run([chat({ content: "Opens at 9." })]).result).rejects.toMatchObject({
      code: "no_pages",
    });
  });

  it("drops hours outside the trip and rejects an over-long description", async () => {
    const outside = {
      ...data,
      hours: [...data.hours, { date: "2027-01-01", start: "09:00", end: "18:00" }],
    };
    expect((await run(happy(outside)).result).data.hours).toHaveLength(1);
    await expect(
      run(happy({ ...data, description: "x".repeat(121) })).result,
    ).rejects.toMatchObject({ code: "extract_failed" });
  });

  it("requires the model to say whether the place is closed, and stores the answer", async () => {
    const closed = { ...data, hours: [], closed_during_trip: true };
    const { requests, result } = run(happy(closed));
    expect((await result).data.closed_during_trip).toBe(true);
    const schema = requests.at(-1)!.body.response_format.json_schema.schema;
    expect(schema.required).toContain("closed_during_trip");
    const { closed_during_trip: _omitted, ...withoutAnswer } = data;
    await expect(run(happy(withoutAnswer)).result).rejects.toMatchObject({
      code: "extract_failed",
    });
  });

  it("keeps a page's own coordinates when geocoding finds nothing", async () => {
    setGeocodeFetchForTest(fakeFetch([jsonResponse([])]).fetchFn);
    const out = await run(happy({ ...data, lat: 1, lng: 2 })).result;
    expect(out.data).toMatchObject({ lat: 1, lng: 2 });
  });

  it("enforces one time budget across research and extract", async () => {
    const { result } = run([fetchCall(SITE), chat({ content: "n" }), hangUntilAborted], {
      budgetMs: 60,
    });
    const started = Date.now();
    await expect(result).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("rejects a trip without valid dates before spending anything", async () => {
    const fake = fakeFetch([chat()]);
    setApexFetchForTest(fake.fetchFn);
    await expect(
      researchPlace({ name: "x", note: null, state: emptyTripState() }),
    ).rejects.toMatchObject({ code: "api" });
    expect(fake.requests).toHaveLength(0);
  });
});

describe("postValidatePlace", () => {
  it("normalizes times, drops bad entries, and nulls unsafe URLs", () => {
    const out = postValidatePlace(
      {
        ...data,
        hours: [
          { date: "2026-12-01", start: "9:30", end: "18:00" },
          { date: "2026-12-02", start: "late", end: "18:00" },
        ],
        website: "javascript:alert(1)",
        place_image_url: "ftp://x/y.png",
      },
      ["2026-12-01", "2026-12-02"],
    );
    expect(out.hours).toEqual([{ date: "2026-12-01", start: "09:30", end: "18:00" }]);
    expect(out.website).toBeNull();
    expect(out.place_image_url).toBeNull();
  });
});

describe("withBudget", () => {
  it("returns results, and ends a call that ignores its signal", async () => {
    expect(await withBudget(1000, async () => 7)).toBe(7);
    await expect(withBudget(20, () => new Promise(() => {}))).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("passes on a parent abort and clears up", async () => {
    const parent = new AbortController();
    const spy = vi.fn();
    const running = withBudget(
      1000,
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            spy();
            reject(new Error("stopped"));
          });
        }),
      parent.signal,
    );
    parent.abort();
    await expect(running).rejects.toMatchObject({
      userMessage: expect.stringMatching(/cancelled/),
    });
    expect(spy).toHaveBeenCalled();
  });
});
