import type { InstancePlace, TripInstance } from "@triplanner/shared";
import { FALLBACK_MAX_PASSES } from "../config/optimizer";
import {
  cheapestTicket,
  effectiveDuration,
  forwardPass,
  placeIndex,
  tauOf,
  type DayPlans,
  type PlannedVisit,
} from "./schedule";

const dayTravel = (instance: TripInstance, sequence: readonly PlannedVisit[]): number => {
  if (sequence.length === 0) return 0;
  let total = 0;
  let previous = "START";
  for (const visit of sequence) {
    total += tauOf(instance, previous, visit.placeId);
    previous = visit.placeId;
  }
  return total + tauOf(instance, previous, "END");
};

export const totalTravel = (instance: TripInstance, plans: DayPlans): number => {
  let total = 0;
  for (const sequence of plans.values()) total += dayTravel(instance, sequence);
  return total;
};

const planSpend = (places: Map<string, InstancePlace>, plans: DayPlans): number => {
  let total = 0;
  for (const [day, sequence] of plans) {
    for (const visit of sequence) {
      const place = places.get(visit.placeId);
      const ticket = place && cheapestTicket(place, day);
      total += ticket ? ticket.price : Number.POSITIVE_INFINITY;
    }
  }
  return total;
};

const withinBudget = (instance: TripInstance, spend: number): boolean =>
  instance.budget === null || spend <= instance.budget + 1e-6;

const dayCap = (instance: TripInstance, day: number): number =>
  instance.days.find((candidate) => candidate.day === day)?.nMax ?? 0;

interface Insertion {
  day: number;
  position: number;
  addedTravel: number;
  start: number;
}

/** §4.8 steps 2 and 3: the feasible (day, position) with the least added travel. */
const bestInsertion = (
  instance: TripInstance,
  places: Map<string, InstancePlace>,
  plans: DayPlans,
  place: InstancePlace,
  shortened: boolean,
): Insertion | null => {
  let best: Insertion | null = null;
  const spend = planSpend(places, plans);
  for (const day of instance.days) {
    const sequence = plans.get(day.day) ?? [];
    if (sequence.length >= day.nMax) continue;
    const ticket = cheapestTicket(place, day.day);
    if (!ticket || !withinBudget(instance, spend + ticket.price)) continue;
    const baseline = dayTravel(instance, sequence);
    for (let position = 0; position <= sequence.length; position += 1) {
      const candidate = [...sequence];
      candidate.splice(position, 0, { placeId: place.id, shortened });
      const timed = forwardPass(instance, places, day.day, candidate);
      if (!timed) continue;
      const addedTravel = dayTravel(instance, candidate) - baseline;
      const start = timed.visits[position]?.start ?? 0;
      if (
        !best ||
        addedTravel < best.addedTravel ||
        (addedTravel === best.addedTravel && start < best.start)
      ) {
        best = { day: day.day, position, addedTravel, start };
      }
    }
  }
  return best;
};

const cloneWith = (plans: DayPlans, changes: [number, PlannedVisit[]][]): DayPlans => {
  const next: DayPlans = new Map(plans);
  for (const [day, sequence] of changes) next.set(day, sequence);
  return next;
};

/** Is every changed day still feasible, and the whole plan within budget? */
const moveFits = (
  instance: TripInstance,
  places: Map<string, InstancePlace>,
  next: DayPlans,
  days: number[],
): boolean => {
  for (const day of days) {
    const sequence = next.get(day) ?? [];
    if (sequence.length > dayCap(instance, day)) return false;
    if (!forwardPass(instance, places, day, sequence)) return false;
  }
  return withinBudget(instance, planSpend(places, next));
};

/** One §4.8 step 4 pass: returns a strictly better plan, or null if none was found. */
const improveOnce = (
  instance: TripInstance,
  places: Map<string, InstancePlace>,
  plans: DayPlans,
): DayPlans | null => {
  const current = totalTravel(instance, plans);
  const days = [...plans.keys()].sort((a, b) => a - b);

  // Move the last visit of the most loaded day to a better day.
  const loaded = days.reduce<number | null>(
    (best, day) =>
      best === null || (plans.get(day)?.length ?? 0) > (plans.get(best)?.length ?? 0) ? day : best,
    null,
  );
  const source = loaded === null ? [] : (plans.get(loaded) ?? []);
  const last = source.at(-1);
  if (loaded !== null && last) {
    for (const target of instance.days) {
      if (target.day === loaded) continue;
      const base = plans.get(target.day) ?? [];
      for (let position = 0; position <= base.length; position += 1) {
        const moved = [...base];
        moved.splice(position, 0, last);
        const next = cloneWith(plans, [
          [loaded, source.slice(0, -1)],
          [target.day, moved],
        ]);
        if (
          totalTravel(instance, next) < current &&
          moveFits(instance, places, next, [loaded, target.day])
        ) {
          return next;
        }
      }
    }
  }

  // Pairwise swaps between days.
  for (const first of days) {
    for (const second of days) {
      if (second <= first) continue;
      const a = plans.get(first) ?? [];
      const b = plans.get(second) ?? [];
      for (let i = 0; i < a.length; i += 1) {
        for (let j = 0; j < b.length; j += 1) {
          const nextA = [...a];
          const nextB = [...b];
          nextA[i] = b[j] as PlannedVisit;
          nextB[j] = a[i] as PlannedVisit;
          const next = cloneWith(plans, [
            [first, nextA],
            [second, nextB],
          ]);
          if (
            totalTravel(instance, next) < current &&
            moveFits(instance, places, next, [first, second])
          ) {
            return next;
          }
        }
      }
    }
  }
  return null;
};

/** §4.8 step 4. Stops after maxPasses consecutive passes that found nothing. */
export const localImprove = (
  instance: TripInstance,
  plans: DayPlans,
  maxPasses: number = FALLBACK_MAX_PASSES,
): { plans: DayPlans; passes: number; improvements: number } => {
  const places = placeIndex(instance);
  let current = plans;
  let passes = 0;
  let improvements = 0;
  let idle = 0;
  while (idle < maxPasses) {
    passes += 1;
    const next = improveOnce(instance, places, current);
    if (next) {
      current = next;
      improvements += 1;
      idle = 0;
    } else {
      idle += 1;
    }
  }
  return { plans: current, passes, improvements };
};

/** §4.8 step 1 to 3: must places first, then by utility. Shortens only what fits no other way. */
export const greedyInsertion = (instance: TripInstance): DayPlans => {
  const places = placeIndex(instance);
  const order = [...instance.places].sort(
    (a, b) =>
      Number(b.must) - Number(a.must) || b.u - a.u || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const plans: DayPlans = new Map();
  let shortenings = 0;
  for (const place of order) {
    let shortened = false;
    let insertion = bestInsertion(instance, places, plans, place, false);
    if (
      !insertion &&
      shortenings < instance.Q &&
      place.delta > 0 &&
      effectiveDuration(place, true) > 0
    ) {
      insertion = bestInsertion(instance, places, plans, place, true);
      shortened = insertion !== null;
    }
    if (!insertion) continue;
    if (shortened) shortenings += 1;
    const sequence = [...(plans.get(insertion.day) ?? [])];
    sequence.splice(insertion.position, 0, { placeId: place.id, shortened });
    plans.set(insertion.day, sequence);
  }
  return plans;
};

export const runFallback = (instance: TripInstance): DayPlans =>
  localImprove(instance, greedyInsertion(instance)).plans;
