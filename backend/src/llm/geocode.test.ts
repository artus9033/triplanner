import { afterEach, describe, expect, it } from "vitest";
import { geocodePlace, setGeocodeFetchForTest } from "./geocode";
import { fakeFetch, jsonResponse } from "./testApi";

afterEach(() => setGeocodeFetchForTest(null));

const hit = jsonResponse([{ lat: "48.86", lon: "2.33" }]);

describe("geocodePlace", () => {
  it("looks up by name and city, identifying the app, and caches the result", async () => {
    const { fetchFn, requests } = fakeFetch([hit]);
    setGeocodeFetchForTest(fetchFn);
    expect(await geocodePlace("Louvre", "Paris", null)).toEqual({ lat: 48.86, lng: 2.33 });
    expect(requests[0]?.url).toContain("q=Louvre%2C%20Paris");
    expect(requests[0]?.headers.get("user-agent")).toMatch(/Triplanner/);
    await geocodePlace("Louvre", "Paris", null);
    expect(requests).toHaveLength(1);
  });

  it("falls back to the address, then to null", async () => {
    const miss = jsonResponse([]);
    const second = fakeFetch([miss, hit]);
    setGeocodeFetchForTest(second.fetchFn);
    expect(await geocodePlace("Odd", "Paris", "1 Rue X")).toEqual({ lat: 48.86, lng: 2.33 });
    expect(second.requests[1]?.url).toContain("q=1%20Rue%20X");
    setGeocodeFetchForTest(fakeFetch([miss]).fetchFn);
    expect(await geocodePlace("Odd", "Paris", "1 Rue X")).toBeNull();
  });

  it("never throws: errors and bad data mean no coordinates", async () => {
    for (const reply of [
      () => Promise.reject(new Error("offline")),
      jsonResponse({}, 429),
      jsonResponse([{ lat: "nope", lon: "2" }]),
    ]) {
      setGeocodeFetchForTest(fakeFetch([reply as Response]).fetchFn);
      expect(await geocodePlace("X", null, null)).toBeNull();
    }
  });

  it("runs one lookup at a time with a pause, as the usage policy requires", async () => {
    let running = 0;
    let peak = 0;
    const times: number[] = [];
    const fake = (async () => {
      running++;
      peak = Math.max(peak, running);
      times.push(Date.now());
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return jsonResponse([{ lat: "1", lon: "2" }]);
    }) as typeof fetch;
    setGeocodeFetchForTest(fake, 40);
    await Promise.all(["A", "B", "C"].map((name) => geocodePlace(name, null, null)));
    expect(peak).toBe(1);
    expect(times[2]! - times[0]!).toBeGreaterThanOrEqual(80);
  });

  it("skips a queued lookup once the budget is gone", async () => {
    const { fetchFn, requests } = fakeFetch([hit]);
    setGeocodeFetchForTest(fetchFn);
    expect(await geocodePlace("Y", null, null, AbortSignal.abort())).toBeNull();
    expect(requests).toHaveLength(0);
  });
});
