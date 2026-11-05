import type {
  DroppedPlace,
  InstancePlace,
  ScheduleItem,
  TicketKind,
  TripInstance,
  TripSchedule,
} from "@triplanner/shared";

/** One visit in a fixed day sequence: what both engines hand over. */
export interface PlannedVisit {
  placeId: string;
  shortened: boolean;
  /** The engine's ticket. A cheaper one eligible that day replaces it. */
  ticketKind?: TicketKind;
}

/** Day number to the visits of that day, in order. */
export type DayPlans = Map<number, PlannedVisit[]>;

export const placeIndex = (instance: TripInstance): Map<string, InstancePlace> =>
  new Map(instance.places.map((place) => [place.id, place]));

export const tauOf = (instance: TripInstance, from: string, to: string): number =>
  instance.tau[from]?.[to] ?? 0;

export const effectiveDuration = (place: InstancePlace, shortened: boolean): number =>
  shortened ? place.dur - place.delta : place.dur;

export const cheapestTicket = (
  place: InstancePlace,
  day: number,
): InstancePlace["tickets"][number] | null => {
  let best: InstancePlace["tickets"][number] | null = null;
  for (const ticket of place.tickets) {
    if (!ticket.eligibleDays.includes(day)) continue;
    if (!best || ticket.price < best.price) best = ticket;
  }
  return best;
};

interface TimedVisit {
  place: InstancePlace;
  shortened: boolean;
  start: number;
  duration: number;
  travelFromPrev: number;
}

/** Forward pass over a fixed sequence: earliest starts, or null if the sequence is impossible. */
export const forwardPass = (
  instance: TripInstance,
  places: Map<string, InstancePlace>,
  day: number,
  sequence: readonly PlannedVisit[],
): { visits: TimedVisit[]; finish: number; returnTravel: number } | null => {
  const info = instance.days.find((candidate) => candidate.day === day);
  if (!info) return null;
  let clock = info.dayStart;
  let previous = "START";
  const visits: TimedVisit[] = [];
  for (const visit of sequence) {
    const place = places.get(visit.placeId);
    const window = place?.windows.find((candidate) => candidate.day === day);
    if (!place || !window) return null;
    const duration = effectiveDuration(place, visit.shortened);
    const travelFromPrev = tauOf(instance, previous, place.id);
    const start = Math.max(clock + travelFromPrev, window.open);
    if (start + duration > window.close) return null;
    visits.push({ place, shortened: visit.shortened, start, duration, travelFromPrev });
    clock = start + duration;
    previous = place.id;
  }
  const returnTravel = sequence.length > 0 ? tauOf(instance, previous, "END") : 0;
  const finish = sequence.length > 0 ? clock + returnTravel : 0;
  if (sequence.length > 0 && finish > info.dayEnd) return null;
  return { visits, finish, returnTravel };
};

/**
 * CPM backward pass, the same semantics as MILP pass 3: the day may not finish later than its own
 * earliest finish F*, so the last visit has no slack and the rest only have the waiting time they
 * can absorb before a window or a later visit binds.
 */
export const latestStarts = (
  instance: TripInstance,
  day: number,
  visits: readonly TimedVisit[],
  finish: number,
  returnTravel: number,
): number[] => {
  const late: number[] = new Array<number>(visits.length).fill(0);
  let nextBound = finish - returnTravel; // Latest allowed end of the last visit.
  for (let index = visits.length - 1; index >= 0; index -= 1) {
    const visit = visits[index] as TimedVisit;
    const window = visit.place.windows.find((candidate) => candidate.day === day);
    const close = window?.close ?? Number.POSITIVE_INFINITY;
    const latest = Math.min(close, nextBound) - visit.duration;
    late[index] = latest;
    nextBound = latest - visit.travelFromPrev;
  }
  return late;
};

const clockLabel = (absolute: number): string => {
  const minutes = ((Math.round(absolute) % 1440) + 1440) % 1440;
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
};

/** §4.7: the reason read off the instance, not guessed. */
const dropReason = (
  instance: TripInstance,
  place: InstancePlace,
  remainingBudget: number | null,
  spend: number,
): Pick<DroppedPlace, "reason" | "detail"> => {
  const reachable = place.windows.filter((window) => {
    const info = instance.days.find((day) => day.day === window.day);
    if (!info) return false;
    const duration = instance.Q > 0 ? place.dur - place.delta : place.dur;
    const start = Math.max(window.open, info.dayStart + tauOf(instance, "START", place.id));
    return (
      start + duration <= window.close &&
      start + duration + tauOf(instance, place.id, "END") <= info.dayEnd
    );
  });
  if (reachable.length === 0) {
    return {
      reason: "unreachable_within_day",
      detail: "Travel from and back to the start leaves too little time on every open day.",
    };
  }
  if (remainingBudget !== null) {
    const prices = reachable.flatMap((window) => {
      const ticket = cheapestTicket(place, window.day);
      return ticket ? [ticket.price] : [];
    });
    const cheapest = prices.length > 0 ? Math.min(...prices) : 0;
    if (cheapest > remainingBudget + 1e-6) {
      const budget = instance.budget ?? 0;
      return {
        reason: "ticket_over_budget",
        detail:
          cheapest > budget
            ? `The cheapest ticket (${cheapest} USD) alone exceeds the budget of ${budget} USD.`
            : `The cheapest ticket (${cheapest} USD) exceeds what is left of the budget after ${spend} USD.`,
      };
    }
  }
  if (place.must) {
    return {
      reason: "unreachable_within_day",
      detail: "It cannot fit alongside the other required places on any open day.",
    };
  }
  return {
    reason: "lower_priority",
    detail: "Higher-priority places filled the available time.",
  };
};

export interface AssembleInput {
  instance: TripInstance;
  plans: DayPlans;
  /** Latest starts from MILP pass 3. Without them the backward pass computes the same values. */
  lateStarts?: Map<string, number>;
  presolveDropped?: DroppedPlace[];
  total?: number;
  quality: TripSchedule["quality"];
  diagnostics: TripSchedule["diagnostics"];
}

/** Fixed sequences to the shared schedule shape. Throws if a sequence is impossible. */
export const assembleSchedule = (input: AssembleInput): TripSchedule => {
  const { instance, plans } = input;
  const places = placeIndex(instance);
  const items: ScheduleItem[] = [];
  const dayEnds: TripSchedule["dayEnds"] = [];
  let travelMin = 0;
  let spend = 0;

  for (const info of [...instance.days].sort((a, b) => a.day - b.day)) {
    const sequence = plans.get(info.day) ?? [];
    if (sequence.length === 0) continue;
    const timed = forwardPass(instance, places, info.day, sequence);
    if (!timed) throw new Error(`Day ${info.day}: the visit sequence does not fit its windows.`);
    const backward = latestStarts(
      instance,
      info.day,
      timed.visits,
      timed.finish,
      timed.returnTravel,
    );

    timed.visits.forEach((visit, index) => {
      const planned = sequence[index] as PlannedVisit;
      const cheapest = cheapestTicket(visit.place, info.day);
      const chosen = visit.place.tickets.find(
        (ticket) => ticket.kind === planned.ticketKind && ticket.eligibleDays.includes(info.day),
      );
      const ticket = chosen && cheapest && chosen.price <= cheapest.price ? chosen : cheapest;
      if (!ticket) throw new Error(`${visit.place.name}: no eligible ticket on day ${info.day}.`);
      const late = input.lateStarts?.get(visit.place.id) ?? (backward[index] as number);
      travelMin += visit.travelFromPrev;
      spend += ticket.price;
      items.push({
        placeId: visit.place.id,
        name: visit.place.name,
        day: info.day,
        date: info.date,
        order: index + 1,
        start: visit.start,
        end: visit.start + visit.duration,
        startLabel: clockLabel(visit.start),
        endLabel: clockLabel(visit.start + visit.duration),
        dur: visit.duration,
        shortened: visit.shortened,
        // Solver values carry tolerances, e.g. 3577.000001.
        slack: Math.max(0, Math.round((late - visit.start) * 1000) / 1000),
        travelFromPrevMin: visit.travelFromPrev,
        ticket: { kind: ticket.kind, price: ticket.price, label: ticket.label },
      });
    });
    travelMin += timed.returnTravel;
    dayEnds.push({ day: info.day, finish: timed.finish, returnTravelMin: timed.returnTravel });
  }

  spend = Math.round(spend * 100) / 100;
  const visited = new Set(items.map((item) => item.placeId));
  const remaining = instance.budget === null ? null : instance.budget - spend;
  const dropped: DroppedPlace[] = [...(input.presolveDropped ?? [])];
  for (const place of instance.places) {
    if (visited.has(place.id)) continue;
    dropped.push({
      placeId: place.id,
      name: place.name,
      must: place.must,
      ...dropReason(instance, place, remaining, spend),
    });
  }

  return {
    quality: input.quality,
    items,
    dayEnds,
    dropped,
    totals: {
      travelMin,
      spend,
      budget: instance.budget,
      covered: items.length,
      total: input.total ?? instance.places.length,
    },
    diagnostics: input.diagnostics,
  };
};
