/**
 * Loads a finished demo trip with no LLM calls, for smoke testing without API spend. Idempotent: the
 * trip id is fixed and each run replaces the previous demo. The coordinates are real; the hours, prices
 * and durations are illustrative, and every place says so.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  TripSchema,
  type HoursEntry,
  type Optimization,
  type PlaceData,
  type Trip,
  type TripPlace,
} from "@triplanner/shared";
import { closeDb, connectDb } from "./db/mongo";
import { deleteTrip, insertTrip } from "./db/trips";
import { optimizeTrip } from "./optimizer";

export const DEMO_TRIP_ID = "demo-paris";
/** The trip starts this many days after the seed runs. */
const LEAD_DAYS = 14;
const TRIP_DAYS = 3;
const DAY_MS = 86_400_000;
const DEMO_SOURCE = {
  url: "https://example.com/triplanner-demo-data",
  title: "Demo data, not checked against any source",
};

type DemoPlace = {
  name: string;
  note: string | null;
  must: boolean;
  category: PlaceData["category"];
  address: string;
  lat: number;
  lng: number;
  website: string;
  description: string;
  durationMin: number;
  open: string;
  close: string;
  /** 0 is Sunday. */
  closedOn?: number;
  tickets: PlaceData["tickets"];
  needsReservation: boolean;
};

const PLACES: DemoPlace[] = [
  {
    name: "Louvre Museum",
    note: "Richelieu wing",
    must: true,
    category: "museum",
    address: "Rue de Rivoli, 75001 Paris",
    lat: 48.8606,
    lng: 2.3376,
    website: "https://www.louvre.fr/en",
    description:
      "DEMO DATA, hours and prices are illustrative. World-famous art museum in a former royal palace.",
    durationMin: 150,
    open: "09:00",
    close: "18:00",
    closedOn: 2,
    tickets: [
      { type: "paid", price: "22EUR", condition: null },
      { type: "free", price: null, condition: "under 18 free" },
    ],
    needsReservation: true,
  },
  {
    name: "Musée d'Orsay",
    note: null,
    must: true,
    category: "museum",
    address: "1 Rue de la Légion d'Honneur, 75007 Paris",
    lat: 48.86,
    lng: 2.3266,
    website: "https://www.musee-orsay.fr/en",
    description:
      "DEMO DATA, hours and prices are illustrative. Impressionist art in a former railway station.",
    durationMin: 120,
    open: "09:30",
    close: "18:00",
    closedOn: 1,
    tickets: [{ type: "paid", price: "16EUR", condition: null }],
    needsReservation: true,
  },
  {
    name: "Eiffel Tower",
    note: "Second floor",
    must: true,
    category: "viewpoint",
    address: "Champ de Mars, 5 Av. Anatole France, 75007 Paris",
    lat: 48.8584,
    lng: 2.2945,
    website: "https://www.toureiffel.paris/en",
    description:
      "DEMO DATA, hours and prices are illustrative. Iron lattice tower with views across the city.",
    durationMin: 90,
    open: "09:30",
    close: "20:00",
    tickets: [{ type: "paid", price: "19EUR", condition: null }],
    needsReservation: true,
  },
  {
    name: "Sainte-Chapelle",
    note: null,
    must: false,
    category: "other",
    address: "10 Bd du Palais, 75001 Paris",
    lat: 48.8554,
    lng: 2.345,
    website: "https://www.sainte-chapelle.fr/en",
    description:
      "DEMO DATA, hours and prices are illustrative. Gothic royal chapel known for its stained glass.",
    durationMin: 45,
    open: "09:00",
    close: "19:00",
    tickets: [{ type: "paid", price: "13EUR", condition: null }],
    needsReservation: false,
  },
  {
    name: "Sacré-Cœur Basilica",
    note: null,
    must: false,
    category: "viewpoint",
    address: "35 Rue du Chevalier de la Barre, 75018 Paris",
    lat: 48.8867,
    lng: 2.3431,
    website: "https://www.sacre-coeur-montmartre.com/english/",
    description:
      "DEMO DATA, hours and prices are illustrative. Hilltop basilica in Montmartre with a city view.",
    durationMin: 45,
    open: "09:00",
    close: "20:00",
    tickets: [{ type: "free", price: null, condition: null }],
    needsReservation: false,
  },
  {
    name: "Le Procope",
    note: null,
    must: false,
    category: "restaurant",
    address: "13 Rue de l'Ancienne Comédie, 75006 Paris",
    lat: 48.853,
    lng: 2.3388,
    website: "https://www.procope.com/en/",
    description:
      "DEMO DATA, hours and prices are illustrative. Historic café and restaurant dating from 1686.",
    durationMin: 90,
    open: "12:00",
    close: "20:00",
    tickets: [],
    needsReservation: false,
  },
];

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const demoPlace = (place: DemoPlace, index: number, dates: string[]): TripPlace => {
  const hours: HoursEntry[] = dates
    .filter((date) => new Date(`${date}T00:00:00Z`).getUTCDay() !== place.closedOn)
    .map((date) => ({ date, start: place.open, end: place.close }));
  return {
    id: `demo-place-${index + 1}`,
    name: place.name,
    note: place.note,
    must: place.must,
    rank: index + 1,
    status: "done",
    error: null,
    data: {
      place: place.name,
      category: place.category,
      address: place.address,
      lat: place.lat,
      lng: place.lng,
      phone: null,
      website: place.website,
      hours,
      description: place.description,
      visit_duration_min: place.durationMin,
      google_place_id: null,
      google_maps_url: `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}`,
      place_image_url: null,
      tickets: place.tickets,
      needs_reservation: place.needsReservation,
    },
    sources: [DEMO_SOURCE],
    model: null,
    durationMs: null,
  };
};

/** The finished demo trip, with its optimization still pending. Uses nothing but `now`. */
export const buildDemoTrip = (now: Date): Trip => {
  const start = now.getTime() + LEAD_DAYS * DAY_MS;
  const dates = Array.from({ length: TRIP_DAYS }, (_, i) => isoDate(start + i * DAY_MS));
  const stamp = now.toISOString();
  const places = PLACES.map((place, i) => demoPlace(place, i, dates));
  const message = (id: string, role: "user" | "assistant", content: string) => ({
    id,
    role,
    content,
    createdAt: stamp,
  });
  return TripSchema.parse({
    id: DEMO_TRIP_ID,
    title: "Paris demo trip",
    step: "final",
    state: {
      city: "Paris",
      start_date: dates[0],
      end_date: dates.at(-1),
      plans: "See the classic museums and viewpoints, with one long lunch.",
      named_places: PLACES.filter((p) => p.must).map((p) => ({ name: p.name, note: p.note })),
      needs_search: false,
      budget_answered: true,
      budget_usd: 150,
    },
    messages: [
      message(
        "demo-message-1",
        "user",
        `Paris from ${dates[0]} to ${dates.at(-1)}. The Louvre, the Musée d'Orsay and the Eiffel Tower are musts.`,
      ),
      message(
        "demo-message-2",
        "assistant",
        "Noted. Is there anything else you would like to fit in, and what is your budget for tickets?",
      ),
      message(
        "demo-message-3",
        "user",
        "Sainte-Chapelle, Sacré-Cœur and lunch at Le Procope if they fit. 150 USD for tickets.",
      ),
      message(
        "demo-message-4",
        "assistant",
        "This is a demo trip: its hours and prices are illustrative, and no web research was done.",
      ),
    ],
    proposals: { status: "idle", items: [], error: null },
    places,
    optimization: {
      status: "pending",
      startedAt: null,
      instanceHash: null,
      result: null,
      error: null,
    },
    createdAt: stamp,
    updatedAt: stamp,
  });
};

const USABLE = new Set<Optimization["status"]>(["solved", "fallback"]);

/** Runs the real optimizer. If AMPL cannot produce a schedule, the heuristic is used instead. */
export const scheduleDemoTrip = async (trip: Trip, now: Date): Promise<Trip> => {
  const input = { state: trip.state, places: trip.places };
  let outcome;
  try {
    outcome = await optimizeTrip(input);
  } catch (e) {
    console.warn(
      `The optimizer failed (${e instanceof Error ? e.message : String(e)}), using the heuristic`,
    );
  }
  if (!outcome || !USABLE.has(outcome.status)) {
    outcome = await optimizeTrip(input, { amplBin: null });
  }
  if (!USABLE.has(outcome.status)) {
    throw new Error(
      `The demo trip could not be scheduled: ${outcome.status} ${outcome.error ?? ""}`,
    );
  }
  return TripSchema.parse({
    ...trip,
    optimization: {
      status: outcome.status,
      startedAt: now.toISOString(),
      instanceHash: outcome.instanceHash,
      result: outcome.result,
      error: outcome.error,
    },
  });
};

const main = async (): Promise<void> => {
  const now = new Date();
  const trip = await scheduleDemoTrip(buildDemoTrip(now), now);
  await connectDb();
  try {
    await deleteTrip(trip.id);
    await insertTrip(trip);
  } finally {
    await closeDb();
  }
  const { status, result } = trip.optimization;
  console.log(
    `Seeded the demo trip: ${status}, ${result?.totals.covered ?? 0} of ${result?.totals.total ?? 0} places scheduled.`,
  );
  const fallbackReason = result?.diagnostics.fallbackReason;
  if (fallbackReason) console.log(`The heuristic ran because: ${fallbackReason}`);
  console.log(`/trips/${trip.id}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
