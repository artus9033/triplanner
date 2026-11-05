import type {
  InstancePlace,
  PlaceData,
  Ticket,
  TripInstance,
  TripPlace,
  TripState,
} from "@triplanner/shared";

/** Day d's absolute minute for a clock time. */
export const at = (day: number, hour: number, minute = 0): number =>
  1440 * (day - 1) + hour * 60 + minute;

export type PlaceSpec = Partial<Omit<InstancePlace, "id" | "windows" | "tickets">> & {
  id: string;
  /** Per day [open, close] in absolute minutes. Default: open all envelope on every day. */
  windows?: { day: number; open: number; close: number }[];
  tickets?: InstancePlace["tickets"];
};

export interface InstanceSpec {
  days?: number;
  places: PlaceSpec[];
  /** "A>B": minutes. Anything missing is 0. S and E stand for START and END. */
  tau?: Record<string, number>;
  /** Fills every leg not in tau. */
  tauDefault?: number;
  budget?: number | null;
  Q?: number;
  nMax?: number;
  /** Clock hours of the daily envelope. Default 9 to 20. */
  envelope?: [number, number];
  lamCost?: number;
}

/** A hand-made instance. Dates start on Monday 2026-11-02. */
export const makeInstance = (spec: InstanceSpec): TripInstance => {
  const dayCount = spec.days ?? 1;
  const [from, to] = spec.envelope ?? [9, 20];
  const days = Array.from({ length: dayCount }, (_, index) => ({
    day: index + 1,
    date: new Date(Date.UTC(2026, 10, 2 + index)).toISOString().slice(0, 10),
    dayStart: at(index + 1, from),
    dayEnd: at(index + 1, to),
    nMax: spec.nMax ?? 4,
  }));
  const places = spec.places.map((place): InstancePlace => {
    const dur = place.dur ?? 60;
    const delta = place.delta ?? Math.round(dur * 0.25);
    const windows =
      place.windows ?? days.map((day) => ({ day: day.day, open: day.dayStart, close: day.dayEnd }));
    return {
      id: place.id,
      name: place.name ?? place.id,
      must: place.must ?? false,
      u: place.u ?? 10,
      dur,
      durMin: place.durMin ?? dur - delta,
      delta,
      windows,
      tickets: place.tickets ?? [
        { kind: "unknown", price: 0, label: null, eligibleDays: windows.map((w) => w.day) },
      ],
    };
  });
  const ids = places.map((place) => place.id);
  const node = (id: string): string => (id === "START" ? "S" : id === "END" ? "E" : id);
  const leg = (a: string, b: string): number =>
    spec.tau?.[`${node(a)}>${node(b)}`] ?? spec.tauDefault ?? 0;
  const tau: TripInstance["tau"] = {};
  for (const a of ["START", ...ids]) {
    const row: Record<string, number> = {};
    for (const b of [...ids, "END"]) if (a !== b) row[b] = leg(a, b);
    tau[a] = row;
  }
  return {
    days,
    places,
    tau,
    budget: spec.budget ?? null,
    Q: spec.Q ?? 0,
    lamTau: 1,
    lamCost: spec.lamCost ?? 1e-4,
    lamL1: 0.001,
    mode: "walking",
  };
};

export const makeState = (start: string, end: string, budget: number | null = null): TripState => ({
  city: "Testville",
  start_date: start,
  end_date: end,
  plans: null,
  named_places: [],
  needs_search: false,
  budget_answered: true,
  budget_usd: budget,
});

export const makeData = (overrides: Partial<PlaceData> = {}): PlaceData => ({
  place: "Place",
  category: "museum",
  address: null,
  lat: 52,
  lng: 21,
  phone: null,
  website: null,
  hours: [],
  description: null,
  visit_duration_min: 60,
  google_place_id: null,
  google_maps_url: null,
  place_image_url: null,
  tickets: [] as Ticket[],
  needs_reservation: null,
  ...overrides,
});

export const hoursOn = (dates: string[], start = "09:00", end = "20:00"): PlaceData["hours"] =>
  dates.map((date) => ({ date, start, end }));

export const makePlace = (
  id: string,
  data: Partial<PlaceData> | null,
  overrides: Partial<TripPlace> = {},
): TripPlace => ({
  id,
  name: id,
  note: null,
  must: false,
  rank: 1,
  status: "done",
  error: null,
  data: data === null ? null : makeData(data),
  sources: [],
  model: null,
  durationMs: null,
  ...overrides,
});

/** Small deterministic PRNG, so random tests are stable. */
export const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
