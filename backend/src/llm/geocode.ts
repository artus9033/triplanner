import { GEOCODE_INTERVAL_MS, GEOCODE_URL, PAGE_USER_AGENT } from "../config/llm";

export type LatLng = { lat: number; lng: number };

let geocodeFetch: typeof fetch = (...args) => fetch(...args);
let queue: Promise<unknown> = Promise.resolve();
let intervalMs = GEOCODE_INTERVAL_MS;
const cache = new Map<string, LatLng>();

export const setGeocodeFetchForTest = (fake: typeof fetch | null, interval = 0): void => {
  geocodeFetch = fake ?? ((...args) => fetch(...args));
  intervalMs = fake ? interval : GEOCODE_INTERVAL_MS;
  cache.clear();
  queue = Promise.resolve();
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One lookup at a time with a pause between them, as Nominatim's usage policy requires. */
const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
  const turn = queue.then(work, work);
  queue = turn.then(
    () => wait(intervalMs),
    () => wait(intervalMs),
  );
  return turn;
};

const lookup = async (query: string, signal?: AbortSignal): Promise<LatLng | null> => {
  const cached = cache.get(query);
  if (cached) return cached;
  const found = await inTurn(async () => {
    if (signal?.aborted) return null;
    const url = `${GEOCODE_URL}?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
    const res = await geocodeFetch(url, {
      headers: { "user-agent": PAGE_USER_AGENT },
      signal,
    });
    if (!res.ok) return null;
    const [first] = (await res.json()) as { lat?: string; lon?: string }[];
    const [lat, lng] = [Number(first?.lat), Number(first?.lon)];
    return first && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  });
  if (found) cache.set(query, found);
  return found;
};

/**
 * Coordinates from OpenStreetMap, tried by name and then by address. Never throws: without
 * coordinates a place still works, it just has no pin and uses a default travel time.
 */
export const geocodePlace = async (
  name: string,
  city: string | null,
  address: string | null,
  signal?: AbortSignal,
): Promise<LatLng | null> => {
  const queries = [city ? `${name}, ${city}` : name, ...(address ? [address] : [])];
  try {
    for (const query of queries) {
      const found = await lookup(query, signal);
      if (found) return found;
    }
  } catch (err) {
    console.warn(`[llm] geocoding failed: ${(err as Error).name}`);
  }
  return null;
};
