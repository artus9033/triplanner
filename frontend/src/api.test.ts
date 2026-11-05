import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiRequestError, setUnauthorizedHandler } from "./api";
import { jsonResponse, makeTrip, stubFetch } from "./test/fixtures";

afterEach(() => setUnauthorizedHandler(null));

describe("api client", () => {
  it("returns validated data", async () => {
    stubFetch({ "GET /api/trips/t1": jsonResponse(makeTrip()) });
    expect((await api.getTrip("t1")).title).toBe("Paris in May");
  });

  it("accepts a trip with and without the optional solverOptions", async () => {
    const solverOptions = { allowShortening: true, dayWindow: { start: "08:00", end: "22:00" } };
    stubFetch({ "GET /api/trips/t1": jsonResponse({ ...makeTrip(), solverOptions }) });
    expect((await api.getTrip("t1")).solverOptions).toEqual(solverOptions);
    stubFetch({ "GET /api/trips/t1": jsonResponse(makeTrip()) });
    expect((await api.getTrip("t1")).solverOptions).toBeUndefined();
  });

  it("throws the API's error text with the status", async () => {
    stubFetch({ "GET /api/trips/t1": jsonResponse({ error: "Trip not found" }, 404) });
    const error = await api.getTrip("t1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).message).toBe("Trip not found");
    expect((error as ApiRequestError).status).toBe(404);
  });

  it("gives readable text for a non-JSON error body", async () => {
    stubFetch({ "GET /api/trips": new Response("<html>Bad gateway</html>", { status: 502 }) });
    await expect(api.listTrips()).rejects.toThrow("HTTP 502");
  });

  it("rejects a response that breaks the contract and names the field", async () => {
    stubFetch({ "GET /api/trips/t1": jsonResponse({ ...makeTrip(), step: "not-a-step" }) });
    await expect(api.getTrip("t1")).rejects.toThrow(/unexpected response.*step/);
  });

  it("rejects an unparseable 200", async () => {
    stubFetch({ "GET /api/trips": new Response("nope", { status: 200 }) });
    await expect(api.listTrips()).rejects.toThrow(/unreadable/);
  });

  it("reports network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(api.listTrips()).rejects.toThrow("Could not reach the server: Failed to fetch");
  });

  it("sends the contract's bodies", async () => {
    const trip = makeTrip();
    const { calls } = stubFetch({
      "POST /api/trips": jsonResponse(trip, 201),
      "POST /api/trips/t1/messages": jsonResponse(trip),
      "POST /api/trips/t1/proposals/confirm": jsonResponse(trip),
      "POST /api/trips/t1/proposals/retry": jsonResponse(trip),
      "POST /api/trips/t1/places/p%2F1/retry": jsonResponse(trip),
      "POST /api/trips/t1/optimize": jsonResponse(trip),
      "POST /api/trips/t1/finalize": jsonResponse(trip),
      "POST /api/speech/tts": new Response(new Blob(["wav"]), { status: 200 }),
    });
    await api.createTrip();
    await api.sendMessage("t1", "hi");
    await api.confirmProposals("t1", ["a", "b"]);
    await api.retryProposals("t1");
    await api.retryPlace("t1", "p/1");
    await api.optimize("t1", { allowShortening: true });
    await api.finalize("t1");
    await api.tts("hello");
    expect(calls.map((c) => c.body)).toEqual([
      undefined,
      { content: "hi" },
      { placeIds: ["a", "b"] },
      undefined,
      undefined,
      { allowShortening: true },
      undefined,
      { text: "hello" },
    ]);
  });

  it("validates the transcribe response", async () => {
    stubFetch({ "POST /api/speech/transcribe": jsonResponse({ nope: 1 }) });
    await expect(api.transcribe(new Blob(["x"]))).rejects.toThrow(/unexpected response/);
    stubFetch({ "POST /api/speech/transcribe": jsonResponse({ text: "hello" }) });
    await expect(api.transcribe(new Blob(["x"]))).resolves.toBe("hello");
  });

  it("without a gate handler, a 401 is a normal error", async () => {
    stubFetch({ "GET /api/trips": jsonResponse({ error: "This app needs a password." }, 401) });
    await expect(api.listTrips()).rejects.toThrow("needs a password");
  });

  it("with a gate handler, a 401 waits and then re-sends", async () => {
    let unlocked = false;
    const { calls } = stubFetch({
      "POST /api/trips/t1/messages": () =>
        unlocked ? jsonResponse(makeTrip()) : jsonResponse({ error: "locked" }, 401),
    });
    setUnauthorizedHandler(async () => {
      unlocked = true;
    });
    await expect(api.sendMessage("t1", "hi")).resolves.toBeTruthy();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual({ content: "hi" });
  });

  it("auth never waits on the gate, so a wrong password is an error", async () => {
    const handler = vi.fn(async () => undefined);
    setUnauthorizedHandler(handler);
    stubFetch({ "POST /api/auth": jsonResponse({ error: "Wrong password." }, 401) });
    await expect(api.auth("bad")).rejects.toThrow("Wrong password.");
    expect(handler).not.toHaveBeenCalled();
  });
});
