import { describe, expect, it } from "vitest";
import {
  DEFAULT_DURATIONS,
  MODE_SPEEDS,
  MUST_UTILITY,
  OPTIONAL_UTILITY,
  UNKNOWN_TRAVEL_MIN,
} from "../config/optimizer";
import { buildInstance, parseClock, parsePrice, resolveCondition } from "./buildInstance";
import { hoursOn, makeInstance, makePlace, makeState } from "./testFixtures";
import { writeData } from "./writeData";

const MON = "2026-11-02";
const TUE = "2026-11-03";
const WED = "2026-11-04";

const ticketsFor = (
  tickets: { type: "free" | "paid" | "reduced"; price: string | null; condition: string | null }[],
  dates = [MON, TUE, WED],
) =>
  buildInstance({
    state: makeState(dates[0] as string, dates.at(-1) as string),
    places: [makePlace("A", { hours: hoursOn(dates), tickets })],
  });

describe("parsePrice", () => {
  it.each([
    ["20USD", 20],
    ["$12.50", 12.5],
    ["€15", 16.2],
    ["15 EUR", 16.2],
    ["15eur", 16.2],
    ["12,50 EUR", 13.5],
    ["1,500 JPY", 10.05],
    ["free", 0],
    ["FREE", 0],
    ["£10", 12.7],
    ["40 zł", 10],
  ])("reads %s", (text, usd) => {
    expect(parsePrice(text)).toEqual({ ok: true, usd });
  });

  it("reports an unknown currency and unreadable text", () => {
    expect(parsePrice("20 XYZ")).toEqual({ ok: false, why: "unknown_currency" });
    expect(parsePrice("20")).toEqual({ ok: false, why: "unknown_currency" });
    expect(parsePrice("about twenty")).toEqual({ ok: false, why: "unparsable" });
    expect(parsePrice("$20 USD")).toEqual({ ok: false, why: "unparsable" });
  });
});

describe("resolveCondition", () => {
  it("treats no condition and the default adult ticket as unconditional", () => {
    expect(resolveCondition(null)).toBe("all");
    expect(resolveCondition("  ")).toBe("all");
    expect(resolveCondition("adults")).toBe("all");
    expect(resolveCondition("general admission")).toBe("all");
  });

  it("reads weekdays, any case and plural", () => {
    expect(resolveCondition("on Tuesday it is free")).toEqual(new Set([2]));
    expect(resolveCondition("Sundays and MONDAYS")).toEqual(new Set([0, 1]));
    expect(resolveCondition("free on wednesdays")).toEqual(new Set([3]));
  });

  it("refuses anything that depends on the person or on more than the weekday", () => {
    expect(resolveCondition("under 25")).toBeNull();
    expect(resolveCondition("students")).toBeNull();
    expect(resolveCondition("students on tuesday")).toBeNull();
    expect(resolveCondition("first sunday of the month")).toBeNull();
  });
});

describe("parseClock", () => {
  it("accepts valid times and 24:00, refuses the rest", () => {
    expect(parseClock("09:30")).toBe(570);
    expect(parseClock("24:00")).toBe(1440);
    expect(parseClock("24:30")).toBeNull();
    expect(parseClock("9am")).toBeNull();
    expect(parseClock("12:60")).toBeNull();
  });
});

describe("ticket resolution", () => {
  it("gives a place with no tickets one synthetic unknown on all its days, with a warning", () => {
    const built = ticketsFor([]);
    expect(built.instance.places[0]?.tickets).toEqual([
      { kind: "unknown", price: 0, label: "price unknown", eligibleDays: [1, 2, 3] },
    ]);
    expect(built.warnings.join()).toMatch(/no ticket data/);
  });

  it("limits a weekday ticket to that weekday and adds nothing when another covers the rest", () => {
    const built = ticketsFor([
      { type: "paid", price: "20USD", condition: null },
      { type: "free", price: null, condition: "on tuesday it is free" },
    ]);
    expect(built.instance.places[0]?.tickets).toEqual([
      { kind: "free", price: 0, label: "on tuesday it is free", eligibleDays: [2] },
      { kind: "paid", price: 20, label: null, eligibleDays: [1, 2, 3] },
    ]);
  });

  it("does not let a personal condition remove a place", () => {
    const built = ticketsFor([{ type: "reduced", price: "5USD", condition: "under 25" }]);
    expect(built.instance.places[0]?.tickets).toEqual([
      { kind: "unknown", price: 0, label: "price unknown", eligibleDays: [1, 2, 3] },
    ]);
    expect(built.warnings.join()).toMatch(/under 25/);
  });

  it("covers only the uncovered days with the unknown fallback", () => {
    const built = ticketsFor([{ type: "paid", price: "20USD", condition: "tuesdays" }]);
    expect(built.instance.places[0]?.tickets).toEqual([
      { kind: "paid", price: 20, label: "tuesdays", eligibleDays: [2] },
      { kind: "unknown", price: 0, label: "price unknown", eligibleDays: [1, 3] },
    ]);
  });

  it("treats an unknown currency and an unreadable price as unknown, price 0", () => {
    for (const price of ["20 XYZ", "ask at the desk"]) {
      const built = ticketsFor([{ type: "paid", price, condition: null }]);
      expect(built.instance.places[0]?.tickets).toEqual([
        { kind: "unknown", price: 0, label: null, eligibleDays: [1, 2, 3] },
      ]);
      expect(built.warnings.join()).toContain(price);
    }
  });

  it("collapses same-kind tickets to the cheapest when it covers every day", () => {
    const built = ticketsFor([
      { type: "paid", price: "30USD", condition: null },
      { type: "paid", price: "20USD", condition: null },
    ]);
    expect(built.instance.places[0]?.tickets).toEqual([
      { kind: "paid", price: 20, label: null, eligibleDays: [1, 2, 3] },
    ]);
  });

  it("never understates spend when a same-kind discount covers only some days", () => {
    // A single price must stand for all three days. $10 would understate Monday and Wednesday.
    const built = ticketsFor([
      { type: "paid", price: "20USD", condition: null },
      { type: "paid", price: "10USD", condition: "on tuesday" },
    ]);
    expect(built.instance.places[0]?.tickets).toEqual([
      { kind: "paid", price: 20, label: null, eligibleDays: [1, 2, 3] },
    ]);
    expect(built.warnings.join()).toMatch(/differ in price/);
  });
});

describe("hours", () => {
  it("treats a midnight-crossing or malformed entry as closed that date, with a warning", () => {
    const built = buildInstance({
      state: makeState(MON, WED),
      places: [
        makePlace("A", {
          hours: [
            { date: MON, start: "22:00", end: "02:00" },
            { date: TUE, start: "nine", end: "18:00" },
            { date: WED, start: "10:00", end: "18:00" },
          ],
        }),
      ],
    });
    expect(built.instance.places[0]?.windows).toEqual([
      { day: 3, open: 2880 + 600, close: 2880 + 1080 },
    ]);
    expect(built.warnings.filter((w) => /treated as closed/.test(w))).toHaveLength(2);
  });

  describe("when no hours were found", () => {
    const MID = 0;
    const windowsFor = (
      data: Parameters<typeof makePlace>[1],
      dayWindow?: { start: string; end: string },
    ) =>
      buildInstance(
        { state: makeState(MON, TUE), places: [makePlace("A", data)] },
        dayWindow ? { dayWindow } : {},
      );

    it("assumes daytime on every trip day, clamped to the daily window, with a warning", () => {
      const built = windowsFor({ hours: [] });
      const [place] = built.instance.places;
      expect(built.presolveDropped).toEqual([]);
      expect(place?.hoursAssumed).toBe(true);
      expect(place?.windows).toEqual([
        { day: 1, open: MID + 540, close: MID + 1200 },
        { day: 2, open: 1440 + 540, close: 1440 + 1200 },
      ]);
      expect(built.warnings.join()).toMatch(/assuming 08:00-22:00/);
    });

    it("uses the assumed 08:00-22:00 in full when the daily window is wider", () => {
      const built = windowsFor({ hours: [] }, { start: "06:00", end: "23:30" });
      expect(built.instance.places[0]?.windows[0]).toEqual({ day: 1, open: 480, close: 1320 });
    });

    it("treats all-unusable hours the same way", () => {
      const built = windowsFor({ hours: [{ date: MON, start: "22:00", end: "02:00" }] });
      expect(built.presolveDropped).toEqual([]);
      expect(built.instance.places[0]?.hoursAssumed).toBe(true);
    });

    it("keeps a place out when its own pages say it is closed", () => {
      const built = windowsFor({ hours: [], closed_during_trip: true });
      expect(built.instance.places).toEqual([]);
      expect(built.presolveDropped[0]).toMatchObject({ reason: "closed_on_trip_dates" });
    });

    it("still reads a missing date as closed when other dates have hours", () => {
      const built = windowsFor({ hours: hoursOn([TUE]) });
      const [place] = built.instance.places;
      expect(place?.hoursAssumed).toBeUndefined();
      expect(place?.windows.map((w) => w.day)).toEqual([2]);
    });

    it("reports a daily window too small for the visit", () => {
      const built = windowsFor({ hours: [] }, { start: "21:30", end: "23:00" });
      expect(built.presolveDropped[0]).toMatchObject({ reason: "outside_daily_envelope" });
    });
  });

  it("clamps to the envelope, and uses the longest part of a split day", () => {
    const built = buildInstance({
      state: makeState(MON, MON),
      places: [
        makePlace("A", {
          hours: [
            { date: MON, start: "07:00", end: "12:00" },
            { date: MON, start: "14:00", end: "23:00" },
          ],
        }),
      ],
    });
    expect(built.instance.places[0]?.windows).toEqual([{ day: 1, open: 840, close: 1200 }]);
    expect(built.warnings.join()).toMatch(/split/);
  });

  it("uses durMin for availability only when shortening is allowed", () => {
    const place = makePlace("A", {
      hours: hoursOn([MON], "10:00", "11:40"),
      visit_duration_min: 120,
    });
    const strict = buildInstance({ state: makeState(MON, MON), places: [place] });
    expect(strict.instance.Q).toBe(0);
    expect(strict.instance.places).toHaveLength(0);
    const relaxed = buildInstance(
      { state: makeState(MON, MON), places: [place] },
      { allowShortening: true },
    );
    expect(relaxed.instance.Q).toBe(3);
    expect(relaxed.instance.places[0]).toMatchObject({ dur: 120, delta: 30, durMin: 90 });
  });
});

describe("instance values", () => {
  it("takes durations from the category table when the bot found none", () => {
    const built = buildInstance({
      state: makeState(MON, MON),
      places: [
        makePlace("A", { hours: hoursOn([MON]), category: "viewpoint", visit_duration_min: null }),
      ],
    });
    expect(built.instance.places[0]?.dur).toBe(DEFAULT_DURATIONS.viewpoint);
  });

  it("derives utility from must and rank", () => {
    const built = buildInstance({
      state: makeState(MON, MON),
      places: [
        makePlace("A", { hours: hoursOn([MON]) }, { must: true }),
        makePlace("B", { hours: hoursOn([MON]) }, { rank: 4 }),
      ],
    });
    expect(built.instance.places.map((p) => p.u)).toEqual([MUST_UTILITY, OPTIONAL_UTILITY / 4]);
  });

  it("computes travel by haversine, in whole minutes rounded up", () => {
    // 0.01 degrees of latitude = 1.112 km = 14.83 min at 4.5 km/h. Anchor is the midpoint.
    const built = buildInstance({
      state: makeState(MON, MON),
      places: [
        makePlace("A", { hours: hoursOn([MON]), lat: 52, lng: 21 }),
        makePlace("B", { hours: hoursOn([MON]), lat: 52.01, lng: 21 }),
      ],
    });
    expect(MODE_SPEEDS.walking).toBe(4.5);
    expect(built.instance.tau.A?.B).toBe(15);
    expect(built.instance.tau.START?.A).toBe(8);
    expect(built.instance.tau.B?.END).toBe(8);
  });

  it("caps travel at a day", () => {
    const built = buildInstance({
      state: makeState(MON, MON),
      places: [
        makePlace("A", { hours: hoursOn([MON]), lat: 0, lng: 0 }),
        makePlace("B", { hours: hoursOn([MON]), lat: 60, lng: 100 }),
      ],
    });
    expect(built.instance.tau.A?.B).toBe(1440);
    expect(built.instance.tau.START?.A).toBeLessThanOrEqual(1440);
  });

  it("uses the unknown travel time both ways for a place with no coordinates", () => {
    const built = buildInstance({
      state: makeState(MON, MON),
      places: [
        makePlace("A", { hours: hoursOn([MON]), lat: 52, lng: 21 }),
        makePlace("B", { hours: hoursOn([MON]), lat: null, lng: null }),
      ],
    });
    expect(built.instance.tau.A?.B).toBe(UNKNOWN_TRAVEL_MIN);
    expect(built.instance.tau.B?.A).toBe(UNKNOWN_TRAVEL_MIN);
    expect(built.instance.tau.START?.B).toBe(UNKNOWN_TRAVEL_MIN);
    expect(built.instance.tau.B?.END).toBe(UNKNOWN_TRAVEL_MIN);
    // The anchor is the centroid of known places only: A itself.
    expect(built.instance.tau.START?.A).toBe(0);
    expect(built.warnings.join()).toMatch(/no coordinates/);
  });

  it("escapes reserved ids and maps them back", () => {
    const built = buildInstance({
      state: makeState(MON, MON),
      places: [makePlace("END", { hours: hoursOn([MON]) })],
    });
    expect(built.instance.places[0]?.id).toBe("place:END");
    expect(built.originalIds.get("place:END")).toBe("END");
  });

  it("rejects missing, inverted and impossible dates", () => {
    const places = [makePlace("A", { hours: hoursOn([MON]) })];
    expect(() => buildInstance({ state: makeState("", MON), places })).toThrow(/dates/);
    expect(() => buildInstance({ state: makeState(TUE, MON), places })).toThrow(/ends before/);
    expect(() => buildInstance({ state: makeState("2026-02-30", "2026-03-01"), places })).toThrow(
      /dates/,
    );
  });
});

describe("writeData", () => {
  it("is ASCII, uses safe symbols, and omits budget when there is none", () => {
    const instance = makeInstance({
      places: [{ id: `o'hara "x" é;`, name: "東京" }, { id: "plain" }],
      tauDefault: 1,
    });
    const { dat, symbols } = writeData(instance);
    expect(/^[\x20-\x7e\n]*$/.test(dat)).toBe(true);
    expect(symbols.get("p0")).toBe('o\'hara "x" é;');
    expect(symbols.get("p1")).toBe("plain");
    expect(dat).not.toContain("budget");
    expect(writeData({ ...instance, budget: 12.5 }).dat).toContain("param budget := 12.5;");
  });

  it("does not depend on the order of places", () => {
    const places = [{ id: "A" }, { id: "B" }, { id: "C" }];
    const one = makeInstance({ places, tauDefault: 2 });
    const two = { ...one, places: [...one.places].reverse() };
    expect(writeData(one).dat).toBe(writeData(two).dat);
  });

  it("formats numbers one fixed way", () => {
    const instance = makeInstance({ places: [{ id: "A", u: 10 / 3, dur: 100 }] });
    const { dat } = writeData(instance);
    expect(dat).toContain("p0 3.333333");
    expect(dat).toContain("p0 100\n");
  });
});
