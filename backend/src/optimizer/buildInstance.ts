import { ASSUMED_OPEN_HOURS } from "@triplanner/shared";
import type {
  DroppedPlace,
  InstancePlace,
  PlaceData,
  Ticket,
  TicketKind,
  TripInstance,
  TripPlace,
  TripState,
} from "@triplanner/shared";
import {
  DAY_WINDOW,
  DEFAULT_DURATIONS,
  FX_TO_USD,
  LAMBDA_L1,
  LAMBDA_TRAVEL,
  MAX_VISITS_PER_DAY,
  MODE_SPEEDS,
  MUST_UTILITY,
  OPTIONAL_UTILITY,
  SHORTEN_BUDGET,
  SHORTEN_BUDGET_ALLOWED,
  SHORTEN_FRACTION,
  TRANSPORT_MODE,
  UNKNOWN_TRAVEL_MIN,
} from "../config/optimizer";

export interface BuildOptions {
  allowShortening?: boolean;
  forcePlaceIds?: string[];
  dayWindow?: { start: string; end: string };
}

export interface BuiltInstance {
  instance: TripInstance;
  /** Places removed before the solver ran, with their reason. */
  presolveDropped: DroppedPlace[];
  warnings: string[];
  /** Done places, whether or not they reached the instance. */
  total: number;
  /** Instance id to the trip's place id, where they differ (reserved ids only). */
  originalIds: Map<string, string>;
}

/** The trip itself cannot be turned into an instance, e.g. no dates. */
export class InstanceError extends Error {}

/**
 * Keeps ticket choice sensible when there is no budget: the design has lamCost = 0 then, which would
 * leave a paid ticket and a free one tied. Too small to move a visit (a day's move costs 28.8 in L1).
 */
const NO_BUDGET_TICKET_TIEBREAK = 1e-4;
const MINUTES_PER_DAY = 1440;
const EARTH_RADIUS_KM = 6371;
const RESERVED_IDS = new Set(["START", "END", "__proto__"]);

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_WORD = /^(sun|mon|tues|wednes|thurs|fri|satur)days?$/;
/**
 * A condition made only of these words (plus weekday names) can be resolved without knowing anything
 * about the traveller. Anything else ("under", "25", "students", "first", "month") cannot, so the
 * ticket is not eligible. "adult" and "general admission" count as unconditional: they describe the
 * default ticket, and dropping it would leave the place priced at 0.
 */
const FILLER_WORDS = new Set(
  (
    "on in at the a it is are every each only and or all day days entry admission ticket tickets " +
    "price free paid reduced adult adults general standard regular normal full"
  ).split(" "),
);

const CURRENCY_SYMBOLS: Record<string, string> = {
  "€": "EUR",
  $: "USD",
  "£": "GBP",
  "¥": "JPY",
  ZŁ: "PLN",
};

export const parseClock = (value: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours === 24 && minutes === 0) return MINUTES_PER_DAY;
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null;
};

const parseDate = (value: string | null): number | null => {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(time).toISOString().slice(0, 10) === value ? time : null;
};

export type ParsedPrice =
  { ok: true; usd: number } | { ok: false; why: "unparsable" | "unknown_currency" };

const parseAmount = (text: string): number => {
  // "1,200" and "1.200" are thousands; "12,50" is a decimal comma.
  const normalized = /^\d{1,3}([.,]\d{3})+$/.test(text)
    ? text.replace(/[.,]/g, "")
    : text.replace(",", ".");
  return Number(normalized);
};

/** Parses "20USD", "€15", "15 EUR", "$12.50" and "free" into USD, rounded to cents. */
export const parsePrice = (raw: string): ParsedPrice => {
  const text = raw.trim();
  if (/^free$/i.test(text)) return { ok: true, usd: 0 };
  const match =
    /^([€$£¥]|[A-Za-z]{3})?\s*(\d[\d.,]*)\s*([€$£¥]|zł|[A-Za-z]{3})?$/i.exec(text) ?? null;
  if (!match) return { ok: false, why: "unparsable" };
  const amount = parseAmount(match[2] ?? "");
  if (!Number.isFinite(amount)) return { ok: false, why: "unparsable" };
  if (match[1] && match[3]) return { ok: false, why: "unparsable" };
  const unit = (match[1] ?? match[3] ?? "").toUpperCase();
  const code = CURRENCY_SYMBOLS[unit] ?? unit;
  const rate = FX_TO_USD[code];
  if (rate === undefined) return { ok: false, why: "unknown_currency" };
  return { ok: true, usd: Math.round(amount * rate * 100) / 100 };
};

/** The weekdays (0 = Sunday) a condition holds on: "all", some days, or null if unresolvable. */
export const resolveCondition = (condition: string | null): "all" | Set<number> | null => {
  if (condition === null || condition.trim() === "") return "all";
  const words = condition.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const days = new Set<number>();
  for (const word of words) {
    if (WEEKDAY_WORD.test(word)) {
      days.add(WEEKDAYS.indexOf(word.replace(/s$/, "")));
    } else if (!FILLER_WORDS.has(word)) {
      return null;
    }
  }
  return days.size > 0 ? days : "all";
};

const toRad = (degrees: number): number => (degrees * Math.PI) / 180;

const haversineKm = (a: [number, number], b: [number, number]): number => {
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** Whole minutes, rounded up. Capped at a day, which keeps the model's big-M dominating. */
const travelMinutes = (a: [number, number], b: [number, number]): number =>
  Math.min(MINUTES_PER_DAY, Math.ceil((haversineKm(a, b) / MODE_SPEEDS[TRANSPORT_MODE]) * 60));

interface DayInfo {
  day: number;
  date: string;
  weekday: number;
  dayStart: number;
  dayEnd: number;
}

const buildDays = (
  state: TripState,
  window: { start: string; end: string },
): { days: DayInfo[]; startMin: number; endMin: number } => {
  const first = parseDate(state.start_date);
  const last = parseDate(state.end_date);
  if (first === null || last === null) {
    throw new InstanceError("The trip has no valid start and end dates.");
  }
  if (last < first) throw new InstanceError("The trip ends before it starts.");
  const startMin = parseClock(window.start);
  const endMin = parseClock(window.end);
  if (startMin === null || endMin === null || endMin <= startMin) {
    throw new InstanceError(`Invalid daily window ${window.start}-${window.end}.`);
  }
  const days: DayInfo[] = [];
  for (let time = first, day = 1; time <= last; time += 86_400_000, day += 1) {
    const offset = MINUTES_PER_DAY * (day - 1);
    days.push({
      day,
      date: new Date(time).toISOString().slice(0, 10),
      weekday: new Date(time).getUTCDay(),
      dayStart: offset + startMin,
      dayEnd: offset + endMin,
    });
  }
  return { days, startMin, endMin };
};

interface HoursResult {
  /** Windows are the assumed hours, because none were found. */
  assumed?: boolean;
  windows: { day: number; open: number; close: number }[];
  dropped: { reason: DroppedPlace["reason"]; detail: string } | null;
}

/** §4.1: hours to envelope-clamped windows. Bad or overnight entries read as closed on that date. */
const resolveHours = (
  data: PlaceData,
  name: string,
  days: DayInfo[],
  minDuration: number,
  warnings: string[],
): HoursResult => {
  const rawByDay = new Map<number, { open: number; close: number }[]>();
  let datedEntries = 0;
  for (const entry of data.hours) {
    const info = days.find((day) => day.date === entry.date);
    if (!info) continue;
    datedEntries += 1;
    const start = parseClock(entry.start);
    const end = parseClock(entry.end);
    if (start === null || end === null || end <= start) {
      warnings.push(
        `${name}: hours ${entry.start}-${entry.end} on ${entry.date} are malformed or cross midnight; treated as closed that date.`,
      );
      continue;
    }
    const offset = MINUTES_PER_DAY * (info.day - 1);
    const list = rawByDay.get(info.day) ?? [];
    list.push({ open: offset + start, close: offset + end });
    rawByDay.set(info.day, list);
  }

  const windows: HoursResult["windows"] = [];
  let bestRaw = 0;
  for (const info of days) {
    const raw = rawByDay.get(info.day);
    if (!raw) continue;
    // Merge touching intervals. A model window is single, so a split day keeps its longest part.
    const merged: { open: number; close: number }[] = [];
    for (const span of [...raw].sort((a, b) => a.open - b.open)) {
      const last = merged.at(-1);
      if (last && span.open <= last.close) last.close = Math.max(last.close, span.close);
      else merged.push({ ...span });
    }
    if (merged.length > 1) {
      warnings.push(`${name}: split opening hours on ${info.date}; using the longest interval.`);
    }
    const clamped = merged
      .map((span) => ({
        open: Math.max(span.open, info.dayStart),
        close: Math.min(span.close, info.dayEnd),
      }))
      .sort((a, b) => b.close - b.open - (a.close - a.open) || a.open - b.open)[0];
    for (const span of merged) bestRaw = Math.max(bestRaw, span.close - span.open);
    if (clamped && clamped.close - clamped.open >= minDuration) {
      windows.push({ day: info.day, open: clamped.open, close: clamped.close });
    }
  }
  if (windows.length > 0) return { windows, dropped: null };

  if (data.closed_during_trip) {
    return {
      windows,
      dropped: {
        reason: "closed_on_trip_dates",
        detail: "The place's own pages say it is closed on your dates.",
      },
    };
  }
  // Nothing usable was found, which says nothing about when it is open: assume normal daytime hours.
  // Hours found for only some dates are different, and there a missing date still means closed.
  if (data.hours.length === 0 || (datedEntries > 0 && rawByDay.size === 0)) {
    const [open, close] = [ASSUMED_OPEN_HOURS.start, ASSUMED_OPEN_HOURS.end].map(
      (time) => parseClock(time) as number,
    ) as [number, number];
    const assumed = days.flatMap((info) => {
      const midnight = MINUTES_PER_DAY * (info.day - 1);
      const start = Math.max(midnight + open, info.dayStart);
      const end = Math.min(midnight + close, info.dayEnd);
      return end - start >= minDuration ? [{ day: info.day, open: start, close: end }] : [];
    });
    if (assumed.length > 0) {
      warnings.push(
        `${name}: no opening hours found; assuming ${ASSUMED_OPEN_HOURS.start}-${ASSUMED_OPEN_HOURS.end}.`,
      );
      return { windows: assumed, dropped: null, assumed: true };
    }
    return {
      windows: [],
      dropped: {
        reason: "outside_daily_envelope",
        detail: `No opening hours were found, and the daily window leaves too little of the assumed ${ASSUMED_OPEN_HOURS.start}-${ASSUMED_OPEN_HOURS.end} for a ${minDuration} min visit.`,
      },
    };
  }
  if (datedEntries === 0) {
    return {
      windows,
      dropped: {
        reason: "closed_on_trip_dates",
        detail: "Opening hours exist, but none on the trip's dates.",
      },
    };
  }
  if (bestRaw < minDuration) {
    return {
      windows,
      dropped: {
        reason: "unreachable_within_day",
        detail: `Open at most ${bestRaw} min on any trip day, but the visit needs ${minDuration} min.`,
      },
    };
  }
  return {
    windows,
    dropped: {
      reason: "outside_daily_envelope",
      detail: `Too little of the opening hours falls inside the daily window for a ${minDuration} min visit.`,
    },
  };
};

interface Variant {
  kind: TicketKind;
  price: number;
  label: string | null;
  eligibleDays: number[];
}

const scrapedVariant = (
  ticket: Ticket,
  name: string,
  days: number[],
  warnings: string[],
): Variant => {
  const label = ticket.condition?.trim() || null;
  if (ticket.type === "free") return { kind: "free", price: 0, label, eligibleDays: days };
  if (ticket.price === null) {
    warnings.push(`${name}: ${ticket.type} ticket has no price; treated as unknown, price 0.`);
    return { kind: "unknown", price: 0, label, eligibleDays: days };
  }
  const parsed = parsePrice(ticket.price);
  if (!parsed.ok) {
    warnings.push(
      `${name}: price "${ticket.price}" has ${parsed.why === "unknown_currency" ? "an unknown currency" : "an unreadable format"}; treated as unknown, price 0.`,
    );
    return { kind: "unknown", price: 0, label, eligibleDays: days };
  }
  return { kind: ticket.type, price: parsed.usd, label, eligibleDays: days };
};

/**
 * The instance holds one entry per kind with one price. When the cheapest variant of a kind covers
 * every day the kind is sold on, it stands for the kind. When it does not (e.g. paid $20, or $10 on
 * Tuesdays), the entry takes the highest day-by-day cheapest price over all those days: that can
 * overstate the discount day but never understates spend against the budget.
 */
const collapseKind = (variants: Variant[], name: string, warnings: string[]): Variant => {
  const sorted = [...variants].sort((a, b) => a.price - b.price);
  const cheapest = sorted[0] as Variant;
  const allDays = [...new Set(variants.flatMap((variant) => variant.eligibleDays))].sort(
    (a, b) => a - b,
  );
  if (cheapest.eligibleDays.length === allDays.length)
    return { ...cheapest, eligibleDays: allDays };
  const price = Math.max(
    ...allDays.map((day) =>
      Math.min(...variants.filter((v) => v.eligibleDays.includes(day)).map((v) => v.price)),
    ),
  );
  warnings.push(
    `${name}: ${cheapest.kind} tickets differ in price by day; using ${price} USD on all of those days.`,
  );
  return { ...(sorted.find((v) => v.price === price) ?? cheapest), price, eligibleDays: allDays };
};

const KIND_ORDER: TicketKind[] = ["free", "paid", "reduced", "unknown"];

const resolveTickets = (
  data: PlaceData,
  name: string,
  days: DayInfo[],
  windowDays: number[],
  warnings: string[],
): InstancePlace["tickets"] => {
  const byKind = new Map<TicketKind, Variant[]>();
  for (const ticket of data.tickets) {
    const condition = resolveCondition(ticket.condition);
    if (condition === null) {
      warnings.push(`${name}: ticket condition "${ticket.condition}" cannot be resolved; ignored.`);
      continue;
    }
    const eligible = windowDays.filter((day) => {
      if (condition === "all") return true;
      const info = days[day - 1];
      return info !== undefined && condition.has(info.weekday);
    });
    if (eligible.length === 0) continue;
    const variant = scrapedVariant(ticket, name, eligible, warnings);
    byKind.set(variant.kind, [...(byKind.get(variant.kind) ?? []), variant]);
  }

  const tickets: Variant[] = [];
  for (const kind of KIND_ORDER) {
    const variants = byKind.get(kind);
    if (variants) tickets.push(collapseKind(variants, name, warnings));
  }

  // Without this, OneTicket would make the place impossible to visit on an uncovered day.
  const covered = new Set(tickets.flatMap((ticket) => ticket.eligibleDays));
  const uncovered = windowDays.filter((day) => !covered.has(day));
  if (uncovered.length > 0) {
    if (data.tickets.length === 0) {
      warnings.push(`${name}: no ticket data; price treated as unknown, 0.`);
    } else if (uncovered.length === windowDays.length) {
      warnings.push(`${name}: no ticket is known to apply; price treated as unknown, 0.`);
    } else {
      warnings.push(`${name}: no ticket is known to apply on some days; price treated as 0 then.`);
    }
    const unknown = tickets.find((ticket) => ticket.kind === "unknown");
    if (unknown) {
      unknown.eligibleDays = [...unknown.eligibleDays, ...uncovered].sort((a, b) => a - b);
    } else {
      tickets.push({ kind: "unknown", price: 0, label: "price unknown", eligibleDays: uncovered });
    }
  }
  return tickets;
};

const buildTau = (
  places: { id: string; name: string; coords: [number, number] | null }[],
  warnings: string[],
): TripInstance["tau"] => {
  const known = places.flatMap((place) => (place.coords ? [place.coords] : []));
  const anchor: [number, number] | null =
    known.length > 0
      ? [
          known.reduce((sum, c) => sum + c[0], 0) / known.length,
          known.reduce((sum, c) => sum + c[1], 0) / known.length,
        ]
      : null;
  for (const place of places) {
    if (!place.coords) {
      warnings.push(
        `${place.name}: no coordinates; travel to and from it assumed ${UNKNOWN_TRAVEL_MIN} min.`,
      );
    }
  }
  const leg = (a: [number, number] | null, b: [number, number] | null): number =>
    a && b ? travelMinutes(a, b) : UNKNOWN_TRAVEL_MIN;

  const tau: TripInstance["tau"] = { START: { END: 0 }, END: {} };
  const fromStart = tau.START as Record<string, number>;
  for (const place of places) {
    const row: Record<string, number> = { END: leg(place.coords, anchor) };
    for (const other of places) {
      if (other.id !== place.id) row[other.id] = leg(place.coords, other.coords);
    }
    tau[place.id] = row;
    fromStart[place.id] = leg(anchor, place.coords);
  }
  return tau;
};

/** Trip documents to a solver-ready instance (design 02 §4.1), with no LLM and no routing call. */
export const buildInstance = (
  input: { state: TripState; places: TripPlace[] },
  options: BuildOptions = {},
): BuiltInstance => {
  const { state } = input;
  const { days } = buildDays(state, options.dayWindow ?? DAY_WINDOW);
  const Q = options.allowShortening ? SHORTEN_BUDGET_ALLOWED : SHORTEN_BUDGET;
  const forced = new Set(options.forcePlaceIds ?? []);

  const warnings: string[] = [];
  const presolveDropped: DroppedPlace[] = [];
  const originalIds = new Map<string, string>();
  const places: InstancePlace[] = [];
  const located: { id: string; name: string; coords: [number, number] | null }[] = [];

  const usable = input.places
    .filter((place) => place.status === "done" && place.data !== null)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const seen = new Set<string>();
  let total = 0;
  for (const place of usable) {
    if (seen.has(place.id)) {
      warnings.push(`${place.name}: duplicate place id ignored.`);
      continue;
    }
    seen.add(place.id);
    total += 1;
    const data = place.data as PlaceData;
    const must = place.must || forced.has(place.id);

    const dur =
      data.visit_duration_min ?? DEFAULT_DURATIONS[data.category] ?? DEFAULT_DURATIONS.other ?? 60;
    const delta = Math.round(SHORTEN_FRACTION * dur);
    const durMin = dur - delta;
    const needed = Q > 0 ? durMin : dur;

    const hours = resolveHours(data, place.name, days, needed, warnings);
    if (hours.dropped) {
      presolveDropped.push({ placeId: place.id, name: place.name, must, ...hours.dropped });
      continue;
    }

    const id = RESERVED_IDS.has(place.id) ? `place:${place.id}` : place.id;
    if (id !== place.id) originalIds.set(id, place.id);
    places.push({
      id,
      name: place.name,
      must,
      u: must ? MUST_UTILITY : OPTIONAL_UTILITY / place.rank,
      dur,
      durMin,
      delta,
      windows: hours.windows,
      ...(hours.assumed && { hoursAssumed: true }),
      tickets: resolveTickets(
        data,
        place.name,
        days,
        hours.windows.map((window) => window.day),
        warnings,
      ),
    });
    located.push({
      id,
      name: place.name,
      coords: data.lat !== null && data.lng !== null ? [data.lat, data.lng] : null,
    });
  }

  const budget = state.budget_usd;
  const instance: TripInstance = {
    days: days.map((info) => ({
      day: info.day,
      date: info.date,
      dayStart: info.dayStart,
      dayEnd: info.dayEnd,
      nMax: MAX_VISITS_PER_DAY,
    })),
    places,
    tau: buildTau(located, warnings),
    budget,
    Q,
    lamTau: LAMBDA_TRAVEL,
    // §4.2: money in units of the budget share per place, so that it compares with minutes.
    lamCost: budget ? Math.max(1, places.length) / budget : NO_BUDGET_TICKET_TIEBREAK,
    lamL1: LAMBDA_L1,
    mode: TRANSPORT_MODE,
  };
  return { instance, presolveDropped, warnings, total, originalIds };
};
