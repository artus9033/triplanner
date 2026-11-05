import { describe, expect, it } from "vitest";
import type { TripInstance, TripSchedule } from "@triplanner/shared";
import { amplStatus, clearOptimizerCache, optimizeInstance, optimizeTrip } from "./index";
import { at, hoursOn, makeInstance, makePlace, makeState, type InstanceSpec } from "./testFixtures";
import { validateSchedule } from "./validate";

const { available } = await amplStatus();

/** Solves through real AMPL/HiGHS and checks the result with the independent validator. */
const solve = async (
  instance: TripInstance,
): Promise<{ status: string; schedule: TripSchedule }> => {
  const outcome = await optimizeInstance(instance);
  if (!outcome.result) throw new Error(`no result: ${outcome.status} ${outcome.error}`);
  expect(outcome.result.diagnostics.fallbackReason).toBeNull();
  expect(validateSchedule(instance, outcome.result)).toEqual([]);
  return { status: outcome.status, schedule: outcome.result };
};
const solveSpec = (spec: InstanceSpec) => solve(makeInstance(spec));

const summary = (schedule: TripSchedule) =>
  schedule.items.map((i) => [i.placeId, i.day, i.order, i.start, i.end, i.slack]);

const droppedOf = (schedule: TripSchedule, id: string) =>
  schedule.dropped.find((place) => place.placeId === id);

describe.skipIf(!available)("MILP on hand-solved instances", () => {
  it("schedules a single place at day start + START travel", async () => {
    // Open from 09:00. 09:00 + 15 = 555; ends 615; back by 630. One visit: F* binds, slack 0.
    const { status, schedule } = await solveSpec({
      places: [{ id: "A", must: true }],
      tau: { "S>A": 15, "A>E": 15 },
    });
    expect(status).toBe("solved");
    expect(schedule.quality).toBe("optimal");
    expect(summary(schedule)).toEqual([["A", 1, 1, 555, 615, 0]]);
    expect(schedule.items[0]?.startLabel).toBe("09:15");
    expect(schedule.dayEnds).toEqual([{ day: 1, finish: 630, returnTravelMin: 15 }]);
    expect(schedule.totals.travelMin).toBe(30);
  });

  it("schedules a single place at its opening when that is later than arrival", async () => {
    const { schedule } = await solveSpec({
      places: [{ id: "A", windows: [{ day: 1, open: at(1, 10), close: at(1, 18) }] }],
      tau: { "S>A": 15, "A>E": 15 },
    });
    expect(summary(schedule)).toEqual([["A", 1, 1, 600, 660, 0]]);
  });

  it("orders two places forced by windows, with exact times and slack", async () => {
    // A 09:00-11:00, B 12:00-14:00, all legs 10. B then A is impossible (B ends 13:00 at the earliest).
    // A: 550-610. Arrive at B 620, wait to 720, ends 780, F* = 790.
    // Latest: B = 790-10-60 = 720 (slack 0). A = min(660, 720-10) - 60 = 600 (slack 50).
    const { schedule } = await solveSpec({
      places: [
        { id: "A", windows: [{ day: 1, open: at(1, 9), close: at(1, 11) }] },
        { id: "B", windows: [{ day: 1, open: at(1, 12), close: at(1, 14) }] },
      ],
      tauDefault: 10,
    });
    expect(summary(schedule)).toEqual([
      ["A", 1, 1, 550, 610, 50],
      ["B", 1, 2, 720, 780, 0],
    ]);
    expect(schedule.totals.travelMin).toBe(30);
  });

  it("picks the unique travel-minimizing route (pass 2)", async () => {
    // A-B-C costs 1+5+5+1 = 12. Every other order costs at least 26.
    const { schedule } = await solveSpec({
      places: [
        { id: "A", dur: 30 },
        { id: "B", dur: 30 },
        { id: "C", dur: 30 },
      ],
      tau: {
        "S>A": 1,
        "S>B": 10,
        "S>C": 20,
        "A>B": 5,
        "B>A": 5,
        "B>C": 5,
        "C>B": 5,
        "A>C": 10,
        "C>A": 10,
        "A>E": 20,
        "B>E": 10,
        "C>E": 1,
      },
    });
    expect(summary(schedule)).toEqual([
      ["A", 1, 1, 541, 571, 0],
      ["B", 1, 2, 576, 606, 0],
      ["C", 1, 3, 611, 641, 0],
    ]);
    expect(schedule.totals.travelMin).toBe(12);
  });

  it("keeps a far optional place when it fits: coverage beats travel", async () => {
    // Both orders cost 5+120+120 = 245, but only A first has the smaller start times (L1).
    const { schedule } = await solveSpec({
      places: [
        { id: "A", dur: 30, u: 10 },
        { id: "FAR", dur: 30, u: 1 },
      ],
      tau: { "S>A": 5, "A>E": 5, "S>FAR": 120, "FAR>E": 120, "A>FAR": 120, "FAR>A": 120 },
    });
    expect(summary(schedule)).toEqual([
      ["A", 1, 1, 545, 575, 0],
      ["FAR", 1, 2, 695, 725, 0],
    ]);
    expect(schedule.totals.travelMin).toBe(245);
  });

  it("keeps exactly the top-utility places at the daily cap", async () => {
    const { status, schedule } = await solveSpec({
      nMax: 4,
      places: [1, 2, 3, 4, 5, 6].map((rank) => ({ id: `R${rank}`, u: 10 / rank, dur: 30 })),
    });
    expect(status).toBe("solved");
    expect(schedule.items.map((i) => i.placeId).sort()).toEqual(["R1", "R2", "R3", "R4"]);
    expect(droppedOf(schedule, "R5")?.reason).toBe("lower_priority");
    expect(droppedOf(schedule, "R6")?.reason).toBe("lower_priority");
    expect(schedule.totals.covered).toBe(4);
    expect(schedule.totals.total).toBe(6);
  });

  it("puts a place open only on day 2 on day 2", async () => {
    // Day 2 opens at 1440 + 540 = 1980. Arrival 1990. Ends 2050, back by 2060.
    const { schedule } = await solveSpec({
      days: 2,
      places: [{ id: "A", windows: [{ day: 2, open: at(2, 9), close: at(2, 20) }] }],
      tauDefault: 10,
    });
    expect(summary(schedule)).toEqual([["A", 2, 1, 1990, 2050, 0]]);
    expect(schedule.items[0]?.date).toBe("2026-11-03");
    expect(schedule.dayEnds).toEqual([{ day: 2, finish: 2060, returnTravelMin: 10 }]);
  });

  it("drops an expensive optional on a small budget", async () => {
    // A 10 + C 20 = 30 fits 35. Adding B 50 does not, and B alone would drop must A's coverage.
    const paid = (price: number) => [
      { kind: "paid" as const, price, label: null, eligibleDays: [1] },
    ];
    const { status, schedule } = await solveSpec({
      budget: 35,
      lamCost: 0.1,
      places: [
        { id: "A", must: true, u: 100, tickets: paid(10) },
        { id: "B", u: 5, tickets: paid(50) },
        { id: "C", u: 3, tickets: paid(20) },
      ],
    });
    expect(status).toBe("solved");
    expect(schedule.items.map((i) => i.placeId).sort()).toEqual(["A", "C"]);
    expect(schedule.totals.spend).toBe(30);
    expect(droppedOf(schedule, "B")?.reason).toBe("ticket_over_budget");
  });

  it("enforces the budget when one affordable-looking optional is all that remains", async () => {
    // Regression: with a defined Spend variable, AMPL's presolve reduced Budget to "0 <= 14" here.
    const paid = [{ kind: "paid" as const, price: 24, label: null, eligibleDays: [1, 2] }];
    const { status, schedule } = await solveSpec({
      days: 2,
      budget: 14,
      lamCost: 0.01,
      places: [
        { id: "A", u: 100, tickets: paid },
        { id: "B", u: 5, tickets: paid },
      ],
    });
    expect(status).toBe("solved");
    expect(schedule.items).toEqual([]);
    expect(schedule.totals.spend).toBe(0);
    expect(droppedOf(schedule, "A")?.reason).toBe("ticket_over_budget");
    expect(droppedOf(schedule, "B")?.reason).toBe("ticket_over_budget");
  });

  it("reports a must over budget as infeasible with ticket_over_budget", async () => {
    const { status, schedule } = await solveSpec({
      budget: 10,
      lamCost: 0.1,
      places: [
        {
          id: "A",
          must: true,
          u: 100,
          tickets: [{ kind: "paid", price: 20, label: null, eligibleDays: [1] }],
        },
        { id: "B" },
      ],
    });
    expect(status).toBe("infeasible");
    expect(schedule.items.map((i) => i.placeId)).toEqual(["B"]);
    expect(droppedOf(schedule, "A")).toMatchObject({ must: true, reason: "ticket_over_budget" });
    expect(schedule.diagnostics.passes.map((p) => p.name)).toEqual([
      "coverage",
      "elastic",
      "compactness",
      "slack",
    ]);
    expect(schedule.quality).toBe("optimal");
  });

  it("reports a must out of reach from the start as unreachable, others scheduled", async () => {
    // 540 + 700 is past the 20:00 close at 1200, whatever else happens.
    const { status, schedule } = await solveSpec({
      places: [{ id: "M", must: true, u: 100 }, { id: "B" }],
      tau: { "S>M": 700 },
    });
    expect(status).toBe("infeasible");
    expect(schedule.items.map((i) => i.placeId)).toEqual(["B"]);
    expect(droppedOf(schedule, "M")?.reason).toBe("unreachable_within_day");
  });

  it("schedules one of two musts that exclude each other", async () => {
    const window = [{ day: 1, open: at(1, 10), close: at(1, 11) }];
    const { status, schedule } = await solveSpec({
      places: [
        { id: "M1", must: true, u: 100, windows: window },
        { id: "M2", must: true, u: 100, windows: window },
      ],
    });
    expect(status).toBe("infeasible");
    expect(schedule.items).toHaveLength(1);
    expect(schedule.dropped).toHaveLength(1);
    expect(schedule.dropped[0]).toMatchObject({ must: true, reason: "unreachable_within_day" });
  });

  it("gives the visit before a late-opening museum exact slack", async () => {
    // A: 550-610, arrive at MUSEUM 630, wait to 840, ends 960, F* = 970.
    // Latest: MUSEUM = 970-10-120 = 840 (slack 0). A = 840-20-60 = 760 (slack 210).
    const { schedule } = await solveSpec({
      places: [
        { id: "A" },
        { id: "MUSEUM", dur: 120, windows: [{ day: 1, open: at(1, 14), close: at(1, 20) }] },
      ],
      tau: {
        "S>A": 10,
        "A>MUSEUM": 20,
        "MUSEUM>A": 20,
        "S>MUSEUM": 100,
        "A>E": 100,
        "MUSEUM>E": 10,
      },
    });
    expect(summary(schedule)).toEqual([
      ["A", 1, 1, 550, 610, 210],
      ["MUSEUM", 1, 2, 840, 960, 0],
    ]);
  });

  it("bounds slack by closing time when that binds first", async () => {
    // Same, but A closes at 11:00: latest A = min(660, 820) - 60 = 600, slack 50.
    const { schedule } = await solveSpec({
      places: [
        { id: "A", windows: [{ day: 1, open: at(1, 9), close: at(1, 11) }] },
        { id: "MUSEUM", dur: 120, windows: [{ day: 1, open: at(1, 14), close: at(1, 20) }] },
      ],
      tau: { "S>A": 10, "A>MUSEUM": 20, "MUSEUM>E": 10, "S>MUSEUM": 10, "A>E": 10, "MUSEUM>A": 20 },
    });
    expect(summary(schedule)).toEqual([
      ["A", 1, 1, 550, 610, 50],
      ["MUSEUM", 1, 2, 840, 960, 0],
    ]);
  });

  it("keeps slack below a day when days tie (defect 1 regression)", async () => {
    // Both places open on both days and nMax = 1. With free day variables, pass 3 would push a visit
    // one day later for 1440 "slack". Here each is alone on its day, so slack is exactly 0.
    const { schedule } = await solveSpec({
      days: 2,
      nMax: 1,
      places: [
        { id: "A", u: 10 },
        { id: "B", u: 5 },
      ],
      tauDefault: 5,
    });
    expect(schedule.items).toHaveLength(2);
    for (const item of schedule.items) expect(item.slack).toBe(0);
    expect(schedule.items.map((i) => i.start).sort((a, b) => a - b)).toEqual([545, 1985]);
  });

  it("keeps slack below a day for a place alone on a 3-day trip", async () => {
    const { schedule } = await solveSpec({ days: 3, places: [{ id: "A" }] });
    expect(summary(schedule)).toEqual([["A", 1, 1, 540, 600, 0]]);
  });

  it("shortens only up to Q (§4.6)", async () => {
    // 09:00-13:00 is 240 min. A 120 + 20 travel + B 120 = 260. One trim of 30 makes 230.
    const places = [
      { id: "A", dur: 120, u: 10 },
      { id: "B", dur: 120, u: 5 },
    ];
    const tau = { "A>B": 20, "B>A": 20 };
    const strict = await solveSpec({ envelope: [9, 13], places, tau, Q: 0 });
    expect(strict.schedule.items.map((i) => i.placeId)).toEqual(["A"]);

    const relaxed = await solveSpec({ envelope: [9, 13], places, tau, Q: 1 });
    expect(relaxed.schedule.items).toHaveLength(2);
    expect(relaxed.schedule.items.filter((i) => i.shortened)).toHaveLength(1);
    expect(relaxed.schedule.dayEnds[0]?.finish).toBe(at(1, 9) + 230);
  });

  it("uses the budget constraint only when a budget exists", async () => {
    const instance = makeInstance({
      places: [
        {
          id: "A",
          must: true,
          u: 100,
          tickets: [{ kind: "paid", price: 1_000_000, label: null, eligibleDays: [1] }],
        },
      ],
    });
    const { status, schedule } = await solve(instance);
    expect(status).toBe("solved");
    expect(schedule.totals.spend).toBe(1_000_000);
    expect(schedule.totals.budget).toBeNull();
  });
});

describe.skipIf(!available)("optimizeTrip end to end", () => {
  // 2026-11-02 is a Monday, 2026-11-03 a Tuesday.
  const MON = "2026-11-02";
  const TUE = "2026-11-03";

  const tickets = [
    { type: "paid" as const, price: "20USD", condition: null },
    { type: "free" as const, price: null, condition: "on tuesday it is free" },
  ];

  it("reads a date with no hours entry as closed", async () => {
    const outcome = await optimizeTrip({
      state: makeState(MON, TUE),
      places: [makePlace("A", { hours: hoursOn([TUE]) })],
    });
    expect(outcome.status).toBe("solved");
    expect(outcome.result?.items.map((i) => [i.placeId, i.date])).toEqual([["A", TUE]]);
  });

  it("drops a place closed on all dates at presolve, and an optional one stays solved", async () => {
    const outcome = await optimizeTrip({
      state: makeState(MON, TUE),
      places: [
        makePlace("OTHER_DATES", { hours: hoursOn(["2027-01-01"]) }),
        makePlace("CLOSED", { hours: [], closed_during_trip: true }),
        makePlace("OK", { hours: hoursOn([MON]) }),
      ],
    });
    expect(outcome.status).toBe("solved");
    const reasons = Object.fromEntries(
      (outcome.result?.dropped ?? []).map((place) => [place.placeId, place.reason]),
    );
    expect(reasons).toEqual({
      OTHER_DATES: "closed_on_trip_dates",
      CLOSED: "closed_on_trip_dates",
    });
    expect(outcome.result?.items.map((i) => i.placeId)).toEqual(["OK"]);
    expect(outcome.result?.totals.total).toBe(3);
  });

  it("makes a must with no possible day infeasible, others still scheduled", async () => {
    const outcome = await optimizeTrip({
      state: makeState(MON, MON),
      places: [
        makePlace("SHORT", { hours: hoursOn([MON], "10:00", "10:30") }, { must: true }),
        makePlace("LATE", { hours: hoursOn([MON], "21:00", "23:00") }, { must: true }),
        makePlace("OK", { hours: hoursOn([MON]) }),
      ],
    });
    expect(outcome.status).toBe("infeasible");
    expect(outcome.result?.items.map((i) => i.placeId)).toEqual(["OK"]);
    const reasons = Object.fromEntries(
      (outcome.result?.dropped ?? []).map((place) => [place.placeId, place.reason]),
    );
    expect(reasons).toEqual({ SHORT: "unreachable_within_day", LATE: "outside_daily_envelope" });
  });

  it("returns a solved empty schedule when nothing is schedulable and nothing is a must", async () => {
    const outcome = await optimizeTrip({
      state: makeState(MON, MON),
      places: [makePlace("CLOSED", { hours: [], closed_during_trip: true })],
    });
    expect(outcome.status).toBe("solved");
    expect(outcome.result?.items).toEqual([]);
  });

  it("schedules a place with no hours found, on both engines, and marks it", async () => {
    for (const amplBin of [undefined, null]) {
      clearOptimizerCache();
      const outcome = await optimizeTrip(
        {
          state: makeState(MON, MON),
          places: [makePlace("UNKNOWN", { hours: [] }, { must: true })],
        },
        amplBin === null ? { amplBin } : {},
      );
      expect(outcome.status).toBe(amplBin === null ? "fallback" : "solved");
      expect(outcome.result?.dropped).toEqual([]);
      expect(outcome.result?.items[0]).toMatchObject({
        placeId: "UNKNOWN",
        date: MON,
        hoursAssumed: true,
      });
      // The daily window starts at 09:00 and this one place sits at the anchor.
      expect(outcome.result?.items[0]?.startLabel).toBe("09:00");
    }
  });

  it("does not mark a visit whose hours were found", async () => {
    const outcome = await optimizeTrip({
      state: makeState(MON, MON),
      places: [makePlace("OK", { hours: hoursOn([MON]) })],
    });
    expect(outcome.result?.items[0]).not.toHaveProperty("hoursAssumed");
  });

  it("does not pick the free ticket on a Monday", async () => {
    const outcome = await optimizeTrip({
      state: makeState(MON, TUE),
      places: [makePlace("A", { hours: hoursOn([MON, TUE]), tickets })],
    });
    expect(outcome.result?.items[0]).toMatchObject({
      date: MON,
      ticket: { kind: "paid", price: 20 },
    });
    expect(outcome.result?.totals.spend).toBe(20);
  });

  it("picks the free ticket when the visit is on Tuesday", async () => {
    const outcome = await optimizeTrip({
      state: makeState(TUE, TUE),
      places: [makePlace("A", { hours: hoursOn([TUE]), tickets })],
    });
    expect(outcome.result?.items[0]).toMatchObject({
      date: TUE,
      ticket: { kind: "free", price: 0 },
    });
  });

  it("moves the visit to Tuesday when only the free ticket fits the budget", async () => {
    const outcome = await optimizeTrip({
      state: makeState(MON, TUE, 5),
      places: [makePlace("A", { hours: hoursOn([MON, TUE]), tickets })],
    });
    expect(outcome.status).toBe("solved");
    expect(outcome.result?.items[0]).toMatchObject({
      date: TUE,
      ticket: { kind: "free", price: 0 },
    });
  });

  it("fits a must with allowShortening that Q = 0 cannot", async () => {
    // Open 100 min, needs 120. The trim of 25% gives 90.
    const places = [
      makePlace(
        "A",
        { hours: hoursOn([MON], "10:00", "11:40"), visit_duration_min: 120 },
        { must: true },
      ),
    ];
    const strict = await optimizeTrip({ state: makeState(MON, MON), places });
    expect(strict.status).toBe("infeasible");
    expect(strict.result?.dropped[0]?.reason).toBe("unreachable_within_day");

    const relaxed = await optimizeTrip(
      { state: makeState(MON, MON), places },
      { allowShortening: true },
    );
    expect(relaxed.status).toBe("solved");
    expect(relaxed.result?.items[0]).toMatchObject({
      dur: 90,
      shortened: true,
      start: 600,
      end: 690,
    });
  });

  it("treats forcePlaceIds as must", async () => {
    const places = [
      makePlace("A", { hours: hoursOn([MON], "21:00", "22:00") }, { name: "A", must: false }),
    ];
    const loose = await optimizeTrip({ state: makeState(MON, MON), places });
    expect(loose.status).toBe("solved");
    const forced = await optimizeTrip(
      { state: makeState(MON, MON), places },
      { forcePlaceIds: ["A"] },
    );
    expect(forced.status).toBe("infeasible");
    expect(forced.result?.dropped[0]).toMatchObject({
      must: true,
      reason: "outside_daily_envelope",
    });
  });

  it("honours a custom day window", async () => {
    const outcome = await optimizeTrip(
      {
        state: makeState(MON, MON),
        places: [makePlace("A", { hours: hoursOn([MON], "06:00", "23:00") })],
      },
      { dayWindow: { start: "07:30", end: "22:00" } },
    );
    expect(outcome.result?.items[0]?.startLabel).toBe("07:30");
  });

  it("is deterministic, order-independent and cached", async () => {
    clearOptimizerCache();
    const a = makePlace("A", { hours: hoursOn([MON]), lat: 52.2, lng: 21 }, { rank: 1 });
    const b = makePlace("B", { hours: hoursOn([MON]), lat: 52.21, lng: 21.01 }, { rank: 2 });
    const c = makePlace("C", { hours: hoursOn([MON]), lat: 52.22, lng: 21.02 }, { rank: 3 });
    const state = makeState(MON, MON);

    const first = await optimizeTrip({ state, places: [a, b, c] });
    clearOptimizerCache();
    const second = await optimizeTrip({ state, places: [c, a, b] });
    expect(second.instanceHash).toBe(first.instanceHash);
    expect(second.result?.items).toEqual(first.result?.items);

    // A binary that cannot start proves the third answer did not come from a solve.
    const third = await optimizeTrip(
      { state, places: [a, b, c] },
      { amplBin: "/nonexistent/ampl" },
    );
    expect(third.status).toBe("solved");
    expect(third.result?.quality).toBe("optimal");
    expect(third.result?.items).toEqual(second.result?.items);
    expect(third.result?.diagnostics.fallbackReason).toBeNull();
  });

  it("gives a different hash for a different name, id or budget", async () => {
    const state = makeState(MON, MON);
    const base = makePlace("A", { hours: hoursOn([MON]) });
    const hashOf = async (place: typeof base, budget = state) =>
      (await optimizeTrip({ state: budget, places: [place] }, { amplBin: null })).instanceHash;
    const reference = await hashOf(base);
    expect(await hashOf({ ...base, name: "Renamed" })).not.toBe(reference);
    expect(await hashOf({ ...base, id: "Z" })).not.toBe(reference);
    expect(await hashOf(base, makeState(MON, MON, 50))).not.toBe(reference);
  });

  it("carries non-ASCII names and hostile ids through", async () => {
    const hostile = `o'hara "x" y;\n# z`;
    const outcome = await optimizeTrip({
      state: makeState(MON, MON),
      places: [
        makePlace(
          hostile,
          { hours: hoursOn([MON]), lat: 52.2, lng: 21 },
          { name: "Łazienki 東京 é" },
        ),
        makePlace(
          "START",
          { hours: hoursOn([MON]), lat: 52.201, lng: 21 },
          { name: "Named START", rank: 2 },
        ),
        makePlace(
          "__proto__",
          { hours: hoursOn([MON]), lat: 52.202, lng: 21 },
          { name: "Proto", rank: 3 },
        ),
      ],
    });
    expect(outcome.status).toBe("solved");
    expect(outcome.result?.diagnostics.fallbackReason).toBeNull();
    const byId = new Map(outcome.result?.items.map((item) => [item.placeId, item.name]));
    expect(byId.get(hostile)).toBe("Łazienki 東京 é");
    expect(byId.get("START")).toBe("Named START");
    expect(byId.get("__proto__")).toBe("Proto");
  });

  it("counts only done places with data in totals.total", async () => {
    const outcome = await optimizeTrip({
      state: makeState(MON, MON),
      places: [
        makePlace("A", { hours: hoursOn([MON]) }),
        makePlace("FAILED", { hours: hoursOn([MON]) }, { status: "failed" }),
        makePlace("RUNNING", null, { status: "running" }),
      ],
    });
    expect(outcome.result?.totals).toMatchObject({ covered: 1, total: 1 });
  });

  it("accepts undefined options, as the trip flow passes them", async () => {
    const outcome = await optimizeTrip(
      { state: makeState(MON, MON), places: [makePlace("A", { hours: hoursOn([MON]) })] },
      undefined,
    );
    expect(outcome.status).toBe("solved");
    expect(outcome.result?.items).toHaveLength(1);
  });

  it("fails visibly with no dates", async () => {
    const outcome = await optimizeTrip({
      state: { ...makeState(MON, MON), start_date: null },
      places: [],
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/dates/);
  });
});
