import type {
  Optimization,
  ScheduleItem,
  Trip,
  TripPlace,
  TripSchedule,
  TripState,
} from "@triplanner/shared";
import { emptyTripState, TripSchema } from "@triplanner/shared";
import { vi } from "vitest";

export const makeState = (overrides: Partial<TripState> = {}): TripState => ({
  ...emptyTripState(),
  city: "Paris",
  start_date: "2026-05-12",
  end_date: "2026-05-13",
  plans: "Art",
  budget_answered: true,
  budget_usd: 100,
  ...overrides,
});

export const makePlace = (overrides: Partial<TripPlace> = {}): TripPlace => ({
  id: "louvre",
  name: "Louvre",
  note: null,
  must: true,
  rank: 1,
  status: "done",
  error: null,
  data: {
    place: "Louvre Museum",
    category: "museum",
    address: "Rue de Rivoli, Paris",
    lat: 48.8606,
    lng: 2.3376,
    phone: "+33 1 40 20 53 17",
    website: "https://www.louvre.fr/",
    hours: [
      { date: "2026-05-12", start: "09:00", end: "18:00" },
      { date: "2026-05-20", start: "09:00", end: "21:00" },
    ],
    description: "Home of the Mona Lisa.",
    visit_duration_min: 120,
    google_place_id: null,
    google_maps_url: "https://maps.google.com/?q=louvre",
    place_image_url: "https://img.example.com/louvre.jpg",
    tickets: [{ type: "paid", price: "22EUR", condition: "under 18 free" }],
    needs_reservation: true,
  },
  sources: [{ url: "https://www.louvre.fr/visit", title: "Plan your visit" }],
  model: "callstack/Apex",
  durationMs: 1000,
  ...overrides,
});

export const makeItem = (overrides: Partial<ScheduleItem> = {}): ScheduleItem => ({
  placeId: "louvre",
  name: "Louvre Museum",
  day: 1,
  date: "2026-05-12",
  order: 1,
  start: 540,
  end: 660,
  startLabel: "09:00",
  endLabel: "11:00",
  dur: 120,
  shortened: false,
  slack: 30,
  travelFromPrevMin: 0,
  ticket: { kind: "paid", price: 22, label: "Adult" },
  ...overrides,
});

export const makeSchedule = (overrides: Partial<TripSchedule> = {}): TripSchedule => ({
  quality: "optimal",
  items: [makeItem()],
  dayEnds: [{ day: 1, finish: 700, returnTravelMin: 10 }],
  dropped: [],
  totals: { travelMin: 95, spend: 22, budget: 100, covered: 1, total: 2 },
  diagnostics: {
    solver: "highs",
    wallMs: 120,
    instanceHash: "abc",
    passes: [],
    warnings: [],
    fallbackReason: null,
  },
  ...overrides,
});

export const makeOptimization = (overrides: Partial<Optimization> = {}): Optimization => ({
  status: "pending",
  startedAt: null,
  instanceHash: null,
  result: null,
  error: null,
  ...overrides,
});

export const makeTrip = (overrides: Partial<Trip> = {}): Trip => ({
  id: "t1",
  title: "Paris in May",
  step: "intake",
  state: makeState(),
  messages: [],
  proposals: { status: "idle", items: [], error: null },
  places: [],
  optimization: makeOptimization(),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

/** Fixtures must stay valid against the real contract, or the tests prove nothing. */
export const validTrip = (trip: Trip): Trip => TripSchema.parse(trip);

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

type Handler = Response | ((call: RecordedCall) => Response | Promise<Response>);

/**
 * Stubs global fetch with a route table keyed "METHOD /api/path". Unknown routes answer 404 with
 * an ApiError, so a test that forgot a route fails on visible text instead of hanging.
 */
export const stubFetch = (routes: Record<string, Handler>) => {
  const calls: RecordedCall[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // Keep the raw string.
      }
    }
    const call = { method, path, body };
    calls.push(call);
    const handler = routes[`${method} ${path}`];
    if (!handler) return jsonResponse({ error: `No route for ${method} ${path}` }, 404);
    const response = typeof handler === "function" ? await handler(call) : handler;
    return response.clone();
  });
  vi.stubGlobal("fetch", mock);
  return { calls, mock };
};

/** Controllable EventSource, standing in for the browser's in jsdom (which has none). */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

export const stubEventSource = () => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
};
