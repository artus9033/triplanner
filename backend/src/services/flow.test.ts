import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaceData, Trip, TripState } from "@triplanner/shared";
import { getTrip, patchTrip } from "../db/trips";
import { createApp } from "../routes/app";
import { startTestDb } from "../test/mongo";
import type { AppDeps } from "./deps";
import { createTripFlow } from "./tripFlow";

const state: TripState = {
  city: "Paris",
  start_date: "2026-12-01",
  end_date: "2026-12-02",
  plans: "Louvre and galleries",
  named_places: [{ name: "Louvre", note: "Richelieu wing" }],
  needs_search: true,
  budget_answered: true,
  budget_usd: null,
};

const data = (place: string): PlaceData => ({
  place,
  category: "museum",
  address: null,
  lat: 48.86,
  lng: 2.33,
  phone: null,
  website: null,
  hours: [{ date: "2026-12-01", start: "09:00", end: "18:00" }],
  description: null,
  visit_duration_min: null,
  google_place_id: null,
  google_maps_url: null,
  place_image_url: null,
  tickets: [],
  needs_reservation: null,
});

const solved = {
  status: "solved" as const,
  instanceHash: "hash",
  error: null,
  result: {
    quality: "optimal" as const,
    items: [],
    dayEnds: [],
    dropped: [
      { placeId: "x", name: "x", must: false, reason: "lower_priority" as const, detail: "" },
    ],
    totals: { travelMin: 0, spend: 0, budget: null, covered: 1, total: 1 },
    diagnostics: {
      solver: "highs",
      wallMs: 1,
      instanceHash: "hash",
      passes: [],
      warnings: [],
      fallbackReason: null,
    },
  },
};

const fakeDeps = (): { [K in keyof AppDeps]: ReturnType<typeof vi.fn> } & AppDeps =>
  ({
    advanceIntake: vi.fn(async () => ({ state, reply: "Great", complete: true })),
    proposePlaces: vi.fn(async () => [
      {
        id: "p1",
        name: "Palais de Tokyo",
        category: "gallery",
        why: "w",
        link: null,
        link_kind: null,
        sources: [],
      },
      {
        id: "p2",
        name: "Centre Pompidou",
        category: "gallery",
        why: "w",
        link: null,
        link_kind: null,
        sources: [],
      },
    ]),
    researchPlace: vi.fn(async ({ name }: { name: string }) => ({
      data: data(name),
      sources: [{ url: "https://example.com", title: "e" }],
      model: "callstack/Apex",
      durationMs: 5,
    })),
    runBotPool: vi.fn(async (items: unknown[], worker: (i: unknown) => Promise<void>) => {
      await Promise.all(items.map(worker));
    }),
    optimizeTrip: vi.fn(async () => solved),
    amplStatus: vi.fn(async () => ({ available: true, detail: "ok" })),
    checkLlmKey: vi.fn(async () => ({ status: "ready", detail: "ok" })),
    speechStatus: vi.fn(() => ({
      stt: { status: "unavailable", reason: "no model" },
      tts: { status: "ready", reason: null },
    })),
    transcribe: vi.fn(async () => "hello"),
    synthesize: vi.fn(async () => Buffer.from("RIFF")),
  }) as never;

describe("trip flow over HTTP", () => {
  let stop: () => Promise<void>;
  let deps: ReturnType<typeof fakeDeps>;
  let flow: ReturnType<typeof createTripFlow>;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    stop = await startTestDb();
  });
  afterAll(() => stop());
  beforeEach(() => {
    deps = fakeDeps();
    flow = createTripFlow(deps);
    app = createApp(deps, flow);
  });

  const newTrip = async (): Promise<Trip> =>
    (await request(app).post("/api/trips").expect(201)).body;
  const reload = async (id: string): Promise<Trip> =>
    (await request(app).get(`/api/trips/${id}`).expect(200)).body;

  it("runs chat → search → selection → bots → solve → final, persisting every step", async () => {
    const trip = await newTrip();
    const afterChat: Trip = (
      await request(app)
        .post(`/api/trips/${trip.id}/messages`)
        .send({ content: "Paris" })
        .expect(200)
    ).body;
    expect(afterChat.step).toBe("refinement");
    expect(afterChat.title).toBe("Paris");
    expect(afterChat.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    await flow.idle();
    const ready = await reload(trip.id);
    expect(ready.proposals.status).toBe("ready");
    expect(deps.proposePlaces.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);

    await request(app)
      .post(`/api/trips/${trip.id}/proposals/confirm`)
      .send({ placeIds: ["p2"] })
      .expect(200);
    await flow.idle();

    const done = await reload(trip.id);
    expect(done.step).toBe("review");
    expect(done.places.map((p) => [p.name, p.must, p.rank, p.status])).toEqual([
      ["Louvre", true, 1, "done"],
      ["Centre Pompidou", false, 2, "done"],
    ]);
    expect(done.places[0]?.sources).toEqual([{ url: "https://example.com", title: "e" }]);
    expect(done.optimization.status).toBe("solved");

    const final: Trip = (await request(app).post(`/api/trips/${trip.id}/finalize`).expect(200))
      .body;
    expect(final.step).toBe("final");
  });

  it("skips step 1 when every place was named", async () => {
    deps.advanceIntake.mockResolvedValue({
      state: { ...state, needs_search: false },
      reply: "ok",
      complete: true,
    });
    const trip = await newTrip();
    const after: Trip = (
      await request(app).post(`/api/trips/${trip.id}/messages`).send({ content: "x" })
    ).body;
    expect(after.step).toBe("place_data");
    expect(deps.proposePlaces).not.toHaveBeenCalled();
    await flow.idle();
    expect((await reload(trip.id)).optimization.status).toBe("solved");
  });

  it("stays in intake and keeps asking while incomplete", async () => {
    deps.advanceIntake.mockResolvedValue({
      state: { ...state, city: null },
      reply: "Which city?",
      complete: false,
    });
    const trip = await newTrip();
    const after: Trip = (
      await request(app).post(`/api/trips/${trip.id}/messages`).send({ content: "Hi" })
    ).body;
    expect(after.step).toBe("intake");
    expect(after.title).toBe("New trip");
  });

  it("does not store a failed chat turn, and shows the LLM's user message", async () => {
    deps.advanceIntake.mockRejectedValue(
      Object.assign(new Error("secret internals"), { userMessage: "Apex is unavailable." }),
    );
    const trip = await newTrip();
    const res = await request(app)
      .post(`/api/trips/${trip.id}/messages`)
      .send({ content: "Hi" })
      .expect(502);
    expect(res.body.error).toBe("Apex is unavailable.");
    expect((await reload(trip.id)).messages).toEqual([]);
  });

  it("rejects a second send while one is in flight", async () => {
    let release!: () => void;
    deps.advanceIntake.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ state, reply: "r", complete: false });
        }),
    );
    const trip = await newTrip();
    const first = flow.sendMessage(trip.id, "one");
    await vi.waitFor(() => expect(release).toBeDefined());
    await request(app).post(`/api/trips/${trip.id}/messages`).send({ content: "two" }).expect(409);
    release();
    await first;
  });

  it("shows failed proposals with text, and allows retry", async () => {
    deps.proposePlaces.mockRejectedValueOnce(
      Object.assign(new Error("x"), { userMessage: "Web search is disabled." }),
    );
    const trip = await newTrip();
    await request(app).post(`/api/trips/${trip.id}/messages`).send({ content: "x" });
    await flow.idle();
    const failed = await reload(trip.id);
    expect(failed.proposals).toMatchObject({ status: "failed", error: "Web search is disabled." });
    await request(app).post(`/api/trips/${trip.id}/proposals/retry`).expect(200);
    await flow.idle();
    expect((await reload(trip.id)).proposals.status).toBe("ready");
  });

  it("treats an empty search result as a visible failure rather than a dead end", async () => {
    deps.proposePlaces.mockResolvedValueOnce([]);
    const trip = await newTrip();
    await request(app).post(`/api/trips/${trip.id}/messages`).send({ content: "x" });
    await flow.idle();
    expect((await reload(trip.id)).proposals.status).toBe("failed");
  });

  it("rejects confirming an unknown proposal or an empty trip", async () => {
    const trip = await newTrip();
    await request(app).post(`/api/trips/${trip.id}/messages`).send({ content: "x" });
    await flow.idle();
    await request(app)
      .post(`/api/trips/${trip.id}/proposals/confirm`)
      .send({ placeIds: ["nope"] })
      .expect(400);
    await patchTrip(trip.id, { state: { ...state, named_places: [] } });
    await request(app)
      .post(`/api/trips/${trip.id}/proposals/confirm`)
      .send({ placeIds: [] })
      .expect(400);
  });

  it("isolates a failed place, solves the rest, re-solves after a retry", async () => {
    deps.advanceIntake.mockResolvedValue({
      state: {
        ...state,
        needs_search: false,
        named_places: [
          { name: "A", note: null },
          { name: "B", note: null },
        ],
      },
      reply: "ok",
      complete: true,
    });
    deps.researchPlace.mockImplementationOnce(async () => {
      throw Object.assign(new Error("x"), { userMessage: "Timed out after a minute." });
    });
    const trip = await newTrip();
    await request(app).post(`/api/trips/${trip.id}/messages`).send({ content: "x" });
    await flow.idle();
    const after = await reload(trip.id);
    const failed = after.places.find((p) => p.status === "failed")!;
    expect(failed.error).toBe("Timed out after a minute.");
    expect(after.step).toBe("review");
    expect(deps.optimizeTrip).toHaveBeenCalledTimes(1);

    await request(app).post(`/api/trips/${trip.id}/places/${failed.id}/retry`).expect(200);
    await flow.idle();
    const retried = await reload(trip.id);
    expect(retried.places.every((p) => p.status === "done")).toBe(true);
    expect(deps.optimizeTrip).toHaveBeenCalledTimes(2);

    const ok = retried.places[0]!;
    await request(app).post(`/api/trips/${trip.id}/places/${ok.id}/retry`).expect(409);
  });

  it("reports failed optimization when nothing has data", async () => {
    deps.advanceIntake.mockResolvedValue({
      state: { ...state, needs_search: false },
      reply: "ok",
      complete: true,
    });
    deps.researchPlace.mockRejectedValue(new Error("boom"));
    const trip = await newTrip();
    await request(app).post(`/api/trips/${trip.id}/messages`).send({ content: "x" });
    await flow.idle();
    const after = await reload(trip.id);
    expect(after.optimization.status).toBe("failed");
    expect(after.optimization.error).toMatch(/nothing to schedule/);
    expect(deps.optimizeTrip).not.toHaveBeenCalled();
  });

  it("surfaces an optimizer crash as failed text", async () => {
    deps.advanceIntake.mockResolvedValue({
      state: { ...state, needs_search: false },
      reply: "ok",
      complete: true,
    });
    deps.optimizeTrip.mockRejectedValue(new Error("segfault at 0x0"));
    const trip = await newTrip();
    await request(app).post(`/api/trips/${trip.id}/messages`).send({ content: "x" });
    await flow.idle();
    const after = await reload(trip.id);
    expect(after.optimization.status).toBe("failed");
    expect(after.optimization.error).not.toMatch(/segfault/);
  });

  describe("re-solving", () => {
    const reviewTrip = async (): Promise<Trip> => {
      deps.advanceIntake.mockResolvedValue({
        state: {
          ...state,
          needs_search: false,
          named_places: [
            { name: "A", note: null },
            { name: "B", note: null },
          ],
        },
        reply: "ok",
        complete: true,
      });
      const trip = await newTrip();
      await request(app).post(`/api/trips/${trip.id}/messages`).send({ content: "x" });
      await flow.idle();
      deps.researchPlace.mockClear();
      deps.optimizeTrip.mockClear();
      return reload(trip.id);
    };

    it("persists shortening and window choices and passes them on later solves", async () => {
      const trip = await reviewTrip();
      await request(app)
        .post(`/api/trips/${trip.id}/optimize`)
        .send({ allowShortening: true, dayWindow: { start: "08:00", end: "22:00" } })
        .expect(200);
      await flow.idle();
      expect(deps.optimizeTrip.mock.calls[0]?.[1]).toEqual({
        allowShortening: true,
        dayWindow: { start: "08:00", end: "22:00" },
      });
      await request(app).post(`/api/trips/${trip.id}/optimize`).send({}).expect(200);
      await flow.idle();
      expect(deps.optimizeTrip.mock.calls[1]?.[1]).toMatchObject({ allowShortening: true });
    });

    it("drops and forces places", async () => {
      const trip = await reviewTrip();
      await patchTrip(trip.id, {
        places: trip.places.map((p, i) => ({ ...p, must: i === 0 })),
      });
      const [a, b] = trip.places;
      await request(app)
        .post(`/api/trips/${trip.id}/optimize`)
        .send({ dropPlaceIds: [a!.id], forcePlaceIds: [b!.id] })
        .expect(200);
      await flow.idle();
      const after = await reload(trip.id);
      expect(after.places.map((p) => [p.id, p.must])).toEqual([[b!.id, true]]);
    });

    it("extending dates re-researches only the dropped places", async () => {
      const trip = await reviewTrip();
      const [a] = trip.places;
      await patchTrip(trip.id, {
        optimization: {
          ...trip.optimization,
          result: {
            ...solved.result,
            dropped: [
              { placeId: a!.id, name: "A", must: true, reason: "closed_on_trip_dates", detail: "" },
            ],
          },
        },
      });
      await request(app)
        .post(`/api/trips/${trip.id}/optimize`)
        .send({ endDate: "2026-12-05" })
        .expect(200);
      await flow.idle();
      expect(deps.researchPlace).toHaveBeenCalledTimes(1);
      expect(deps.researchPlace.mock.calls[0]?.[0]).toMatchObject({
        name: "A",
        state: { end_date: "2026-12-05" },
      });
      expect(deps.optimizeTrip).toHaveBeenCalledTimes(1);
    });

    it("rejects an end date before the start date and refuses to solve during intake", async () => {
      const trip = await reviewTrip();
      await request(app)
        .post(`/api/trips/${trip.id}/optimize`)
        .send({ endDate: "2020-01-01" })
        .expect(400);
      const fresh = await newTrip();
      await request(app).post(`/api/trips/${fresh.id}/optimize`).send({}).expect(409);
      await request(app).post(`/api/trips/${fresh.id}/finalize`).expect(409);
    });
  });

  it("coalesces overlapping solves into one rerun with the latest data", async () => {
    deps.advanceIntake.mockResolvedValue({
      state: { ...state, needs_search: false },
      reply: "ok",
      complete: true,
    });
    const trip = await newTrip();
    await request(app).post(`/api/trips/${trip.id}/messages`).send({ content: "x" });
    await flow.idle();
    deps.optimizeTrip.mockClear();
    let release!: () => void;
    deps.optimizeTrip.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(solved))),
    );
    await request(app).post(`/api/trips/${trip.id}/optimize`).send({}).expect(200);
    await vi.waitFor(() => expect(release).toBeDefined());
    await request(app).post(`/api/trips/${trip.id}/optimize`).send({}).expect(200);
    await request(app).post(`/api/trips/${trip.id}/optimize`).send({}).expect(200);
    release();
    await flow.idle();
    await vi.waitFor(async () =>
      expect((await getTrip(trip.id))?.optimization.status).toBe("solved"),
    );
    expect(deps.optimizeTrip).toHaveBeenCalledTimes(2);
  });

  it("recovers after a restart: paid work fails visibly, solving restarts", async () => {
    deps.advanceIntake.mockResolvedValue({
      state: { ...state, needs_search: false },
      reply: "ok",
      complete: true,
    });
    const trip = await newTrip();
    await request(app).post(`/api/trips/${trip.id}/messages`).send({ content: "x" });
    await flow.idle();
    const loaded = await reload(trip.id);
    await patchTrip(trip.id, {
      step: "place_data",
      places: [
        { ...loaded.places[0]!, status: "running" },
        { ...loaded.places[0]!, id: "other", status: "done" },
      ],
    });
    deps.researchPlace.mockClear();
    deps.optimizeTrip.mockClear();
    await flow.recoverInterrupted();
    await flow.idle();
    const after = await reload(trip.id);
    expect(after.step).toBe("review");
    expect(after.places[0]).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/restart/),
    });
    expect(deps.researchPlace).not.toHaveBeenCalled();
    expect(deps.optimizeTrip).toHaveBeenCalledTimes(1);
  });

  it("returns health for all four features, speech degraded", async () => {
    const res = await request(app).get("/api/health").expect(200);
    expect(res.body).toMatchObject({
      ok: true,
      db: { status: "ready" },
      ampl: { status: "ready" },
      llm: { status: "ready" },
      speech: { status: "degraded" },
    });
    await request(app).get("/api/health").expect(200);
    expect(deps.checkLlmKey).toHaveBeenCalledTimes(1);
  });

  it("transcribes through the raw audio route and synthesizes speech", async () => {
    const stt = await request(app)
      .post("/api/speech/transcribe")
      .set("Content-Type", "audio/wav")
      .send(Buffer.from("RIFFxxxx"))
      .expect(200);
    expect(stt.body).toEqual({ text: "hello" });
    expect(deps.transcribe.mock.calls[0]?.[1]).toBe("audio/wav");
    const tts = await request(app).post("/api/speech/tts").send({ text: "hi" }).expect(200);
    expect(tts.headers["content-type"]).toMatch(/audio\/wav/);
  });

  it("does not leak unexpected errors, and returns JSON 404 for unknown routes", async () => {
    deps.synthesize.mockRejectedValue(new Error("/secret/path exploded"));
    const res = await request(app).post("/api/speech/tts").send({ text: "hi" }).expect(500);
    expect(JSON.stringify(res.body)).not.toMatch(/secret/);
    const missing = await request(app).get("/api/nope").expect(404);
    expect(missing.body.error).toBe("Not found");
    await request(app).post("/api/trips/none/messages").send({ content: "x" }).expect(404);
    await request(app).post("/api/trips/none/messages").send({ content: "   " }).expect(400);
  });

  describe("password gate", () => {
    beforeEach(() => vi.stubEnv("DEV_ACCESS_PASSWORD", "hunter2"));
    afterEach(() => vi.unstubAllEnvs());

    it("blocks the API without the password and opens with it", async () => {
      await request(app).get("/api/trips").expect(401);
      await request(app).post("/api/speech/transcribe").send(Buffer.from("x")).expect(401);
      await request(app).post("/api/auth").send({ password: "wrong" }).expect(401);
      const agent = request.agent(app);
      const auth = await agent.post("/api/auth").send({ password: "hunter2" }).expect(204);
      expect(auth.headers["set-cookie"]?.[0]).toMatch(/HttpOnly/);
      expect(auth.headers["set-cookie"]?.[0]).not.toMatch(/hunter2/);
      await agent.get("/api/trips").expect(200);
    });

    it("keeps liveness public but hides feature details", async () => {
      const res = await request(app).get("/api/health").expect(200);
      expect(res.body).toEqual({ ok: true, gated: true });
    });
  });

  it("streams trip updates over SSE and stops on disconnect", async () => {
    const trip = await newTrip();
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/trips/${trip.id}/events`, {
        signal: controller.signal,
      });
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      const reader = res.body!.getReader();
      await reader.read();
      deps.advanceIntake.mockResolvedValue({ state, reply: "r", complete: false });
      await flow.sendMessage(trip.id, "hi");
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain(`"trip.updated"`);
    } finally {
      controller.abort();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
