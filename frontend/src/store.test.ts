import { beforeEach, describe, expect, it } from "vitest";
import { resetTripStore, useTripStore } from "./store";
import { jsonResponse, makeTrip, stubFetch } from "./test/fixtures";

const store = () => useTripStore.getState();

beforeEach(() => resetTripStore());

const newer = "2026-02-01T00:00:00.000Z";

describe("trip store", () => {
  it("loads a trip from the server and caches it", async () => {
    stubFetch({ "GET /api/trips/t1": jsonResponse(makeTrip()) });
    await store().openTrip("t1");
    expect(store().trips.t1?.title).toBe("Paris in May");
    expect(store().load.t1?.status).toBe("ready");
    expect(store().currentTripId).toBe("t1");
  });

  it("the server overrides the cache on refetch", async () => {
    store().applyTrip(makeTrip({ title: "Stale" }));
    stubFetch({
      "GET /api/trips/t1": jsonResponse(makeTrip({ title: "Fresh", updatedAt: newer })),
    });
    await store().refetchTrip("t1");
    expect(store().trips.t1?.title).toBe("Fresh");
    expect(store().summaries[0]?.title).toBe("Fresh");
  });

  it("ignores a late response older than the cached trip", () => {
    store().applyTrip(makeTrip({ title: "New", updatedAt: newer }));
    store().applyTrip(makeTrip({ title: "Old" }));
    expect(store().trips.t1?.title).toBe("New");
  });

  it("keeps showing cached data, with the error, when a refetch fails", async () => {
    store().applyTrip(makeTrip());
    stubFetch({ "GET /api/trips/t1": jsonResponse({ error: "Database down" }, 500) });
    await store().refetchTrip("t1");
    expect(store().trips.t1).toBeDefined();
    expect(store().load.t1).toEqual({ status: "ready", error: "Database down" });
  });

  it("marks a deleted trip as missing, and a first-load failure as failed", async () => {
    stubFetch({
      "GET /api/trips/gone": jsonResponse({ error: "Trip not found" }, 404),
      "GET /api/trips/bad": jsonResponse({ error: "Boom" }, 500),
    });
    await store().refetchTrip("gone");
    await store().refetchTrip("bad");
    expect(store().load.gone?.status).toBe("missing");
    expect(store().load.bad).toEqual({ status: "failed", error: "Boom" });
  });

  it("coalesces events during a fetch into one more fetch", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let count = 0;
    stubFetch({
      "GET /api/trips/t1": async () => {
        count++;
        if (count === 1) await gate;
        return jsonResponse(makeTrip({ title: `v${count}`, updatedAt: newer }));
      },
    });
    const first = store().refetchTrip("t1");
    await store().refetchTrip("t1");
    await store().refetchTrip("t1");
    release();
    await first;
    expect(count).toBe(2);
    expect(store().trips.t1?.title).toBe("v2");
  });

  it("switching trips clears view state and leaves other trips' data alone", async () => {
    stubFetch({
      "GET /api/trips/a": jsonResponse(makeTrip({ id: "a", title: "A" })),
      "GET /api/trips/b": jsonResponse(makeTrip({ id: "b", title: "B" })),
    });
    await store().openTrip("a");
    store().setHovered("x");
    store().setSelected("y");
    store().setView("intake");
    store().setHovered("x");
    store().setSelected("y");
    store().setDraft("a", "draft for A");
    await store().openTrip("b");
    expect(store().currentTripId).toBe("b");
    expect(store().hoveredPlaceId).toBeNull();
    expect(store().selectedPlaceId).toBeNull();
    expect(store().viewOverride).toBeNull();
    expect(store().chats.b).toBeUndefined();
    expect(store().chats.a?.draft).toBe("draft for A");
    expect(store().trips.a?.title).toBe("A");
    expect(store().trips.b?.title).toBe("B");
  });

  it("a slow response for the old trip does not touch the open trip", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    stubFetch({
      "GET /api/trips/a": async () => {
        await gate;
        return jsonResponse(makeTrip({ id: "a", title: "A" }));
      },
      "GET /api/trips/b": jsonResponse(makeTrip({ id: "b", title: "B" })),
    });
    const slow = store().openTrip("a");
    await store().openTrip("b");
    release();
    await slow;
    expect(store().currentTripId).toBe("b");
    expect(store().trips.b?.title).toBe("B");
    expect(store().trips.a?.title).toBe("A");
  });

  it("returns to the trip's own step when the server moves it", () => {
    store().applyTrip(makeTrip({ step: "review" }));
    useTripStore.setState({ currentTripId: "t1", viewOverride: "intake" });
    store().applyTrip(makeTrip({ step: "final", updatedAt: newer }));
    expect(store().viewOverride).toBeNull();
  });

  it("a failed send restores the message as the draft, and keeps newer typing", async () => {
    store().applyTrip(makeTrip());
    stubFetch({ "POST /api/trips/t1/messages": jsonResponse({ error: "LLM down" }, 500) });
    await store().sendMessage("t1", "first");
    expect(store().chats.t1).toEqual({ draft: "first", pending: null, error: "LLM down" });

    const sending = store().sendMessage("t1", "second");
    store().setDraft("t1", "typed meanwhile");
    await sending;
    expect(store().chats.t1?.draft).toBe("typed meanwhile");
  });

  it("delete removes the trip from every cache", async () => {
    store().applyTrip(makeTrip());
    store().setDraft("t1", "x");
    stubFetch({ "DELETE /api/trips/t1": new Response(null, { status: 204 }) });
    await store().deleteTrip("t1");
    expect(store().trips.t1).toBeUndefined();
    expect(store().chats.t1).toBeUndefined();
    expect(store().summaries).toEqual([]);
  });

  it("reports a failed trip list", async () => {
    stubFetch({ "GET /api/trips": jsonResponse({ error: "Nope" }, 500) });
    await store().loadTrips();
    expect(store().listStatus).toBe("failed");
    expect(store().listError).toBe("Nope");
  });
});
