import { describe, expect, it } from "vitest";
import type { TripInstance, TripSchedule } from "@triplanner/shared";
import { runFallback } from "./fallback";
import { amplStatus, optimizeInstance } from "./index";
import { assembleSchedule, cheapestTicket, type DayPlans } from "./schedule";
import { at, makeInstance, seededRandom } from "./testFixtures";
import { validateSchedule } from "./validate";

const { available } = await amplStatus();

const diagnostics = {
  solver: null,
  wallMs: 0,
  instanceHash: "",
  passes: [],
  warnings: [],
  fallbackReason: "test",
};

const randomInstance = (seed: number): TripInstance => {
  const random = seededRandom(seed);
  const int = (low: number, high: number): number => low + Math.floor(random() * (high - low + 1));
  const days = 2;
  const count = int(2, 5);
  const ids = Array.from({ length: count }, (_, index) => `P${index}`);
  const tau: Record<string, number> = {};
  const points = new Map([
    ["S", [int(0, 60), int(0, 60)] as const],
    ["E", [int(0, 60), int(0, 60)] as const],
    ...ids.map((id) => [id, [int(0, 60), int(0, 60)] as const] as const),
  ]);
  const distance = (a: string, b: string): number => {
    const [ax, ay] = points.get(a) as readonly [number, number];
    const [bx, by] = points.get(b) as readonly [number, number];
    return Math.ceil(Math.hypot(ax - bx, ay - by));
  };
  for (const a of ids) {
    tau[`S>${a}`] = distance("S", a);
    tau[`${a}>E`] = distance(a, "E");
    for (const b of ids) if (a !== b) tau[`${a}>${b}`] = distance(a, b);
  }
  return makeInstance({
    days,
    nMax: int(1, 3),
    envelope: [9, 18],
    budget: random() < 0.5 ? int(10, 60) : null,
    lamCost: 0.01,
    places: ids.map((id, index) => {
      const windows = [1, 2].flatMap((day) => {
        if (random() < 0.25) return [];
        const open = at(day, int(9, 14));
        return [{ day, open, close: Math.min(open + int(60, 300), at(day, 18)) }];
      });
      const paid = int(0, 30);
      return {
        id,
        must: index === 0 && random() < 0.4,
        u: index === 0 ? 100 : 10 / (index + 1),
        dur: [30, 45, 60, 90][int(0, 3)] as number,
        windows,
        tickets: [
          {
            kind: "paid" as const,
            price: paid,
            label: null,
            eligibleDays: windows.map((w) => w.day),
          },
        ],
      };
    }),
    tau,
  });
};

/** Earliest-start feasibility of one fixed day order. Written apart from the engines on purpose. */
const orderFits = (instance: TripInstance, day: number, order: string[]): boolean => {
  const info = instance.days.find((d) => d.day === day);
  if (!info) return false;
  let clock = info.dayStart;
  let previous = "START";
  for (const id of order) {
    const place = instance.places.find((p) => p.id === id);
    const window = place?.windows.find((w) => w.day === day);
    if (!place || !window) return false;
    const start = Math.max(clock + (instance.tau[previous]?.[id] ?? 0), window.open);
    if (start + place.dur > window.close) return false;
    clock = start + place.dur;
    previous = id;
  }
  return order.length === 0 || clock + (instance.tau[previous]?.END ?? 0) <= info.dayEnd;
};

const permutations = (items: string[]): string[][] =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
          item,
          ...rest,
        ]),
      );

/** Must places outweigh everything, as in the elastic objective. */
const MUST_WEIGHT = 1000;
const coverageValue = (instance: TripInstance, ids: Iterable<string>): number => {
  let total = 0;
  for (const id of ids) {
    const place = instance.places.find((p) => p.id === id);
    if (place) total += place.u + (place.must ? MUST_WEIGHT : 0);
  }
  return total;
};

/** Every assignment of places to day 1, day 2 or nowhere, with every order. Q = 0 instances only. */
const bruteForceCoverage = (instance: TripInstance): number => {
  const ids = instance.places.map((p) => p.id);
  let best = 0;
  for (let code = 0; code < 3 ** ids.length; code += 1) {
    const dayOne: string[] = [];
    const dayTwo: string[] = [];
    let rest = code;
    for (const id of ids) {
      if (rest % 3 === 1) dayOne.push(id);
      if (rest % 3 === 2) dayTwo.push(id);
      rest = Math.floor(rest / 3);
    }
    const [first, second] = instance.days;
    if (!first || !second) continue;
    if (dayOne.length > first.nMax || dayTwo.length > second.nMax) continue;
    const spendFor = (list: string[], day: number): number =>
      list.reduce((sum, id) => {
        const place = instance.places.find((p) => p.id === id);
        const ticket = place && cheapestTicket(place, day);
        return sum + (ticket ? ticket.price : Number.POSITIVE_INFINITY);
      }, 0);
    if (instance.budget !== null && spendFor(dayOne, 1) + spendFor(dayTwo, 2) > instance.budget) {
      continue;
    }
    const value = coverageValue(instance, [...dayOne, ...dayTwo]);
    if (value <= best) continue;
    if (
      permutations(dayOne).some((order) => orderFits(instance, 1, order)) &&
      permutations(dayTwo).some((order) => orderFits(instance, 2, order))
    ) {
      best = value;
    }
  }
  return best;
};

const plansOf = (schedule: TripSchedule): DayPlans => {
  const plans: DayPlans = new Map();
  for (const item of [...schedule.items].sort((a, b) => a.order - b.order)) {
    const list = plans.get(item.day) ?? [];
    list.push({ placeId: item.placeId, shortened: item.shortened });
    plans.set(item.day, list);
  }
  return plans;
};

const sequenceKey = (schedule: TripSchedule): string =>
  schedule.items
    .map((item) => `${item.day}:${item.order}:${item.placeId}`)
    .sort()
    .join("|");

const SEEDS = Array.from({ length: 24 }, (_, index) => 1000 + index);

describe.skipIf(!available)("random instances, both engines", () => {
  it("are valid, match brute force, and agree on slack", async () => {
    let sameSequence = 0;
    let withVisits = 0;
    for (const seed of SEEDS) {
      const instance = randomInstance(seed);
      const label = `seed ${seed}`;

      const outcome = await optimizeInstance(instance, { timeLimitMs: 8000 });
      expect(outcome.result?.diagnostics.fallbackReason, label).toBeNull();
      const milp = outcome.result as TripSchedule;
      expect(milp.quality, label).toBe("optimal");
      expect(validateSchedule(instance, milp), label).toEqual([]);

      const heuristic = assembleSchedule({
        instance,
        plans: runFallback(instance),
        quality: "heuristic",
        diagnostics,
      });
      expect(validateSchedule(instance, heuristic), label).toEqual([]);

      const milpValue = coverageValue(
        instance,
        milp.items.map((i) => i.placeId),
      );
      const heuristicValue = coverageValue(
        instance,
        heuristic.items.map((i) => i.placeId),
      );
      expect(milpValue, label).toBeCloseTo(bruteForceCoverage(instance), 5);
      expect(heuristicValue, label).toBeLessThanOrEqual(milpValue + 1e-9);

      // The slack contract: on MILP's own sequence the heuristic's backward pass must give exactly
      // what pass 3 gave, and the start times of the forward pass with it.
      const replay = assembleSchedule({
        instance,
        plans: plansOf(milp),
        quality: "heuristic",
        diagnostics,
      });
      expect(
        replay.items.map((i) => [i.placeId, i.start, i.slack]),
        label,
      ).toEqual(milp.items.map((i) => [i.placeId, i.start, i.slack]));

      if (milp.items.length > 0) withVisits += 1;
      if (sequenceKey(milp) === sequenceKey(heuristic)) {
        sameSequence += 1;
        expect(
          heuristic.items.map((i) => [i.placeId, i.start, i.slack]),
          label,
        ).toEqual(milp.items.map((i) => [i.placeId, i.start, i.slack]));
      }
    }
    // The checks above only bite if the instances are not all empty or all different.
    expect(withVisits).toBeGreaterThan(SEEDS.length / 2);
    expect(sameSequence).toBeGreaterThan(0);
  }, 60_000);
});
