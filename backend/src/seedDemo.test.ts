import { TripSchema } from "@triplanner/shared";
import { describe, expect, it } from "vitest";
import { buildDemoTrip, DEMO_TRIP_ID } from "./seedDemo";

const now = new Date("2026-03-02T10:00:00Z");

describe("buildDemoTrip", () => {
  const trip = buildDemoTrip(now);

  it("is a valid finished trip with a fixed id", () => {
    expect(TripSchema.safeParse(trip).success).toBe(true);
    expect(trip.id).toBe(DEMO_TRIP_ID);
    expect(trip.step).toBe("final");
    expect(trip.state.city).toBe("Paris");
    expect(trip.state.budget_answered).toBe(true);
  });

  it("is dated in the near future relative to the given time", () => {
    expect(trip.state.start_date).toBe("2026-03-16");
    expect(trip.state.end_date).toBe("2026-03-18");
  });

  it("has 5 or 6 places with complete data, all marked as demo data", () => {
    expect(trip.places.length).toBeGreaterThanOrEqual(5);
    expect(trip.places.length).toBeLessThanOrEqual(6);
    for (const place of trip.places) {
      expect(place.status).toBe("done");
      expect(place.data?.lat).toBeTypeOf("number");
      expect(place.data?.lng).toBeTypeOf("number");
      expect(place.data?.hours.length).toBeGreaterThan(0);
      expect(place.data?.description).toMatch(/^DEMO DATA/);
      expect(place.sources[0]?.title).toMatch(/Demo data/);
    }
  });

  it("honours closed days: the Louvre is closed on the Tuesday", () => {
    const louvre = trip.places.find((p) => p.name === "Louvre Museum");
    expect(louvre?.data?.hours.map((h) => h.date)).toEqual(["2026-03-16", "2026-03-18"]);
  });

  it("has only a few plausible messages", () => {
    expect(trip.messages.length).toBeGreaterThan(1);
    expect(new Set(trip.messages.map((m) => m.id)).size).toBe(trip.messages.length);
  });
});
