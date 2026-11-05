import { describe, expect, it } from "vitest";
import type { TripInstance, TripSchedule } from "@triplanner/shared";
import { greedyInsertion, localImprove, runFallback, totalTravel } from "./fallback";
import { optimizeInstance } from "./index";
import { assembleSchedule, type DayPlans } from "./schedule";
import { at, makeInstance } from "./testFixtures";
import { validateSchedule } from "./validate";

const diagnostics = {
  solver: null,
  wallMs: 0,
  instanceHash: "",
  passes: [],
  warnings: [],
  fallbackReason: "test",
};

const schedule = (instance: TripInstance, plans: DayPlans): TripSchedule =>
  assembleSchedule({ instance, plans, quality: "heuristic", diagnostics });

describe("fallback heuristic", () => {
  it("builds a feasible schedule with travel and windows respected", () => {
    const instance = makeInstance({
      places: [
        { id: "A", windows: [{ day: 1, open: at(1, 9), close: at(1, 11) }] },
        { id: "B", windows: [{ day: 1, open: at(1, 12), close: at(1, 14) }] },
      ],
      tauDefault: 10,
    });
    const result = schedule(instance, runFallback(instance));
    expect(validateSchedule(instance, result)).toEqual([]);
    // The hand-computed answer of the MILP test of the same name, including its slack.
    expect(result.items.map((i) => [i.placeId, i.start, i.slack])).toEqual([
      ["A", 550, 50],
      ["B", 720, 0],
    ]);
  });

  it("places must places first, whatever their utility", () => {
    const instance = makeInstance({
      nMax: 1,
      places: [
        { id: "M", must: true, u: 1 },
        { id: "OPT", u: 50 },
      ],
    });
    const result = schedule(instance, runFallback(instance));
    expect(result.items.map((i) => i.placeId)).toEqual(["M"]);
    expect(result.dropped[0]).toMatchObject({ placeId: "OPT", reason: "lower_priority" });
  });

  it("never exceeds the budget, and takes a cheaper place that still fits", () => {
    const paid = (price: number) => [
      { kind: "paid" as const, price, label: null, eligibleDays: [1] },
    ];
    const instance = makeInstance({
      budget: 30,
      places: [
        { id: "A", must: true, u: 100, tickets: paid(20) },
        { id: "B", u: 50, tickets: paid(20) },
        { id: "C", u: 10, tickets: paid(5) },
      ],
    });
    const result = schedule(instance, runFallback(instance));
    expect(result.items.map((i) => i.placeId).sort()).toEqual(["A", "C"]);
    expect(result.totals.spend).toBe(25);
    expect(result.dropped[0]).toMatchObject({ placeId: "B", reason: "ticket_over_budget" });
  });

  it("uses the free ticket's day when only that fits the budget", () => {
    const instance = makeInstance({
      days: 2,
      budget: 5,
      places: [
        {
          id: "A",
          tickets: [
            { kind: "paid", price: 20, label: null, eligibleDays: [1, 2] },
            { kind: "free", price: 0, label: "tuesday", eligibleDays: [2] },
          ],
        },
      ],
    });
    const result = schedule(instance, runFallback(instance));
    expect(result.items[0]).toMatchObject({ day: 2, ticket: { kind: "free", price: 0 } });
  });

  it("shortens only when a place fits no other way, and only Q times", () => {
    const instance = makeInstance({
      envelope: [9, 13],
      Q: 1,
      places: [
        { id: "A", dur: 120, u: 10 },
        { id: "B", dur: 120, u: 5 },
      ],
      tau: { "A>B": 20, "B>A": 20 },
    });
    const result = schedule(instance, runFallback(instance));
    expect(result.items).toHaveLength(2);
    expect(result.items.filter((i) => i.shortened).map((i) => i.placeId)).toEqual(["B"]);
    expect(validateSchedule(instance, result)).toEqual([]);
  });

  it("leaves a must it cannot place in dropped, with a reason", () => {
    const instance = makeInstance({
      places: [{ id: "M", must: true, u: 100 }],
      tau: { "S>M": 700 },
    });
    const result = schedule(instance, runFallback(instance));
    expect(result.items).toEqual([]);
    expect(result.dropped[0]).toMatchObject({ must: true, reason: "unreachable_within_day" });
  });

  it("minimizes added travel at insertion", () => {
    // B goes between A and C: 1+1+1+1 = 4, against 1+10+... for the others.
    const instance = makeInstance({
      places: [
        { id: "A", u: 30, dur: 10 },
        { id: "C", u: 20, dur: 10 },
        { id: "B", u: 10, dur: 10 },
      ],
      tau: {
        "S>A": 1,
        "A>E": 10,
        "S>B": 5,
        "B>E": 5,
        "S>C": 10,
        "C>E": 1,
        "A>B": 1,
        "B>A": 1,
        "B>C": 1,
        "C>B": 1,
        "A>C": 2,
        "C>A": 2,
      },
    });
    const plans = greedyInsertion(instance);
    expect(plans.get(1)?.map((visit) => visit.placeId)).toEqual(["A", "B", "C"]);
    expect(totalTravel(instance, plans)).toBe(4);
  });
});

describe("local improvement", () => {
  // Two clusters, 100 min apart, 1 min across a cluster, 5 min from the anchor.
  const clusters = makeInstance({
    days: 2,
    nMax: 2,
    places: ["A1", "A2", "B1", "B2"].map((id) => ({ id, dur: 30 })),
    tau: {
      "S>A1": 5,
      "S>A2": 5,
      "S>B1": 5,
      "S>B2": 5,
      "A1>E": 5,
      "A2>E": 5,
      "B1>E": 5,
      "B2>E": 5,
      "A1>A2": 1,
      "A2>A1": 1,
      "B1>B2": 1,
      "B2>B1": 1,
      "A1>B1": 100,
      "B1>A1": 100,
      "A1>B2": 100,
      "B2>A1": 100,
      "A2>B1": 100,
      "B1>A2": 100,
      "A2>B2": 100,
      "B2>A2": 100,
    },
  });
  const visit = (placeId: string) => ({ placeId, shortened: false });

  it("swaps across days when that strictly reduces travel, then stops", () => {
    const start: DayPlans = new Map([
      [1, [visit("A1"), visit("B1")]],
      [2, [visit("A2"), visit("B2")]],
    ]);
    expect(totalTravel(clusters, start)).toBe(220);
    const { plans, passes, improvements } = localImprove(clusters, start, 2);
    expect(totalTravel(clusters, plans)).toBe(22);
    expect(improvements).toBe(1);
    // One improving pass, then the two idle ones the limit asks for.
    expect(passes).toBe(3);
    expect(validateSchedule(clusters, schedule(clusters, plans))).toEqual([]);
  });

  it("stops after exactly the limit of idle passes on an optimal plan", () => {
    const optimal: DayPlans = new Map([
      [1, [visit("A1"), visit("A2")]],
      [2, [visit("B1"), visit("B2")]],
    ]);
    expect(localImprove(clusters, optimal, 2)).toMatchObject({ passes: 2, improvements: 0 });
    expect(localImprove(clusters, optimal, 5)).toMatchObject({ passes: 5, improvements: 0 });
  });

  it("does not accept a move that breaks a window", () => {
    const instance = makeInstance({
      days: 2,
      places: [
        { id: "ONLY_DAY_1", windows: [{ day: 1, open: at(1, 9), close: at(1, 20) }] },
        { id: "ONLY_DAY_2", windows: [{ day: 2, open: at(2, 9), close: at(2, 20) }] },
      ],
      tauDefault: 10,
    });
    const start: DayPlans = new Map([
      [1, [visit("ONLY_DAY_1")]],
      [2, [visit("ONLY_DAY_2")]],
    ]);
    const { plans, improvements } = localImprove(instance, start, 2);
    expect(improvements).toBe(0);
    expect(plans.get(1)?.[0]?.placeId).toBe("ONLY_DAY_1");
  });
});

describe("validateSchedule catches each violation", () => {
  const instance = makeInstance({
    budget: 100,
    nMax: 2,
    places: [
      {
        id: "A",
        tickets: [
          { kind: "paid", price: 10, label: null, eligibleDays: [1] },
          { kind: "free", price: 0, label: null, eligibleDays: [] },
        ],
      },
      { id: "B", windows: [{ day: 1, open: at(1, 12), close: at(1, 14) }] },
    ],
    tauDefault: 10,
  });
  const good = (): TripSchedule => {
    const plans: DayPlans = new Map([
      [
        1,
        [
          { placeId: "A", shortened: false },
          { placeId: "B", shortened: false },
        ],
      ],
    ]);
    return schedule(instance, plans);
  };
  const item = (result: TripSchedule, index: number) => {
    const found = result.items[index];
    if (!found) throw new Error("missing item");
    return found;
  };

  it("passes a good schedule", () => {
    expect(validateSchedule(instance, good())).toEqual([]);
  });

  const mutations: [string, (result: TripSchedule) => void, RegExp][] = [
    [
      "start before opening",
      (r) => {
        item(r, 1).start = 600;
        item(r, 1).end = 660;
      },
      /before opening/,
    ],
    [
      "end after closing",
      (r) => {
        item(r, 1).start = 800;
        item(r, 1).end = 860;
      },
      /after closing/,
    ],
    [
      "no travel time",
      (r) => {
        item(r, 0).start = 541;
        item(r, 0).end = 601;
      },
      /before arrival/,
    ],
    [
      "a second visit",
      (r) => {
        r.items.push({ ...item(r, 1), order: 3 });
      },
      /more than once/,
    ],
    [
      "ineligible ticket",
      (r) => {
        item(r, 0).ticket = { kind: "free", price: 0, label: null };
      },
      /not eligible/,
    ],
    [
      "unknown ticket",
      (r) => {
        item(r, 0).ticket = { kind: "reduced", price: 1, label: null };
      },
      /does not exist/,
    ],
    [
      "negative slack",
      (r) => {
        item(r, 0).slack = -1;
      },
      /negative slack/,
    ],
    [
      "day-long slack",
      (r) => {
        item(r, 0).slack = 1500;
      },
      /spans a day/,
    ],
    [
      "slack over the next start",
      (r) => {
        item(r, 0).slack = 400;
      },
      /latest start/,
    ],
    [
      "slack on the last visit",
      (r) => {
        item(r, 1).slack = 5;
      },
      /moves the finish/,
    ],
    [
      "wrong duration",
      (r) => {
        item(r, 0).dur = 10;
      },
      /duration/,
    ],
    [
      "wrong travel",
      (r) => {
        item(r, 1).travelFromPrevMin = 99;
      },
      /travel 99/,
    ],
    [
      "wrong totals",
      (r) => {
        r.totals.travelMin = 1;
      },
      /totals.travelMin/,
    ],
    [
      "wrong order",
      (r) => {
        item(r, 0).order = 5;
      },
      /order/,
    ],
  ];
  it.each(mutations)("%s", (_name, mutate, expected) => {
    const result = good();
    mutate(result);
    expect(validateSchedule(instance, result).join("\n")).toMatch(expected);
  });

  it("catches a broken cap, budget and shortening count", () => {
    const tight = { ...instance, budget: 5 };
    expect(validateSchedule(tight, good()).join()).toMatch(/over budget/);
    const capped = { ...instance, days: instance.days.map((d) => ({ ...d, nMax: 1 })) };
    expect(validateSchedule(capped, good()).join()).toMatch(/over the cap/);
    const shortened = good();
    const first = item(shortened, 0);
    first.shortened = true;
    first.dur -= 15;
    first.end -= 15;
    expect(validateSchedule(instance, shortened).join()).toMatch(/over Q/);
  });
});

describe("fallback through optimizeInstance", () => {
  it("reports status fallback, quality heuristic and the reason", async () => {
    const instance = makeInstance({ places: [{ id: "A" }], tauDefault: 5 });
    const outcome = await optimizeInstance(instance, { amplBin: null });
    expect(outcome.status).toBe("fallback");
    expect(outcome.result?.quality).toBe("heuristic");
    expect(outcome.result?.diagnostics.fallbackReason).toMatch(/disabled/);
    expect(outcome.result?.diagnostics.solver).toBeNull();
  });
});
