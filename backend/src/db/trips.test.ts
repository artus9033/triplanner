import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb } from "../test/mongo";
import { createTrip, deleteTrip, getTrip, listTrips, patchPlace, patchTrip } from "./trips";
import type { TripPlace } from "@triplanner/shared";

const place = (id: string): TripPlace => ({
  id,
  name: id,
  note: null,
  must: true,
  rank: 1,
  status: "queued",
  error: null,
  data: null,
  sources: [],
  model: null,
  durationMs: null,
});

describe("trips repository", () => {
  let stop: () => Promise<void>;
  beforeAll(async () => {
    stop = await startTestDb();
  });
  afterAll(() => stop());

  it("creates, reads, lists and deletes trips", async () => {
    const trip = await createTrip("Paris");
    expect((await getTrip(trip.id))?.title).toBe("Paris");
    expect((await listTrips()).map((t) => t.id)).toContain(trip.id);
    expect(await deleteTrip(trip.id)).toBe(true);
    expect(await getTrip(trip.id)).toBeNull();
  });

  it("does not lose concurrent updates to different places", async () => {
    const trip = await createTrip();
    await patchTrip(trip.id, { places: [place("a"), place("b"), place("c")] });
    await Promise.all(
      ["a", "b", "c"].map((id) => patchPlace(trip.id, id, { status: "done", durationMs: 1 })),
    );
    const after = await getTrip(trip.id);
    expect(after?.places.map((p) => p.status)).toEqual(["done", "done", "done"]);
  });
});
