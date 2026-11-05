import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Trip } from "@triplanner/shared";
import { App } from "../App";
import { resetTripStore } from "../store";
import {
  FakeEventSource,
  jsonResponse,
  makeItem,
  makeOptimization,
  makePlace,
  makeSchedule,
  makeState,
  makeTrip,
  stubEventSource,
  stubFetch,
  validTrip,
} from "../test/fixtures";
import { renderUi } from "../test/render";

const speech = {
  stt: { status: "unavailable", reason: "off" },
  tts: { status: "unavailable", reason: "off" },
};

const at = (n: number) => `2026-02-0${n}T00:00:00.000Z`;

const summary = (trip: Trip) => ({
  id: trip.id,
  title: trip.title,
  step: trip.step,
  updatedAt: trip.updatedAt,
});

beforeEach(() => {
  resetTripStore();
  stubEventSource();
});

describe("app flow", () => {
  it("walks all steps and every required test id exists along the way", async () => {
    const user = userEvent.setup();
    const seen = new Set<string>();
    const note = () => {
      for (const el of document.querySelectorAll("[data-testid]")) {
        seen.add(el.getAttribute("data-testid")!);
      }
    };

    const fresh = validTrip(makeTrip({ id: "t1", state: makeState({ city: null }) }));
    const refinement = validTrip(
      makeTrip({
        step: "refinement",
        updatedAt: at(1),
        state: makeState({ needs_search: true }),
        proposals: {
          status: "ready",
          error: null,
          items: [
            {
              id: "p1",
              name: "Louvre",
              category: "museum",
              why: "It is the Louvre.",
              link: "https://www.louvre.fr/",
              link_kind: "website",
              sources: [],
            },
          ],
        },
      }),
    );
    const review = validTrip({
      ...refinement,
      step: "review",
      updatedAt: at(2),
      places: [makePlace()],
      optimization: makeOptimization({
        status: "solved",
        result: makeSchedule({ items: [makeItem()] }),
      }),
    });
    const final = validTrip({ ...review, step: "final", updatedAt: at(3) });
    let current = fresh;

    stubFetch({
      "GET /api/trips": () => jsonResponse([]),
      "POST /api/trips": () => jsonResponse(fresh, 201),
      "GET /api/trips/t1": () => jsonResponse(current),
      "GET /api/speech/status": jsonResponse(speech),
      "POST /api/trips/t1/messages": () => jsonResponse((current = refinement)),
      "POST /api/trips/t1/proposals/confirm": () => jsonResponse((current = review)),
      "POST /api/trips/t1/finalize": () => jsonResponse((current = final)),
    });

    renderUi(<App />);
    expect(await screen.findByText("No trips yet.")).toBeInTheDocument();
    note();

    await user.click(screen.getByTestId("new-trip"));
    await screen.findByTestId("chat-input");
    note();

    await user.type(screen.getByTestId("chat-input"), "Art in Paris");
    await user.click(screen.getByTestId("chat-send"));
    await screen.findByTestId("place-option");
    note();

    await user.click(screen.getByRole("checkbox", { name: "Louvre" }));
    await user.click(screen.getByTestId("places-confirm"));
    await screen.findByTestId("place-card");
    await screen.findByTestId("map-pin");
    note();

    await user.click(screen.getByRole("button", { name: "View final schedule" }));
    await screen.findByTestId("final-timeline");
    note();

    for (const id of [
      "new-trip",
      "trip-list",
      "chat-input",
      "chat-send",
      "steps-timeline",
      "place-option",
      "places-confirm",
      "place-card",
      "map-pin",
      "optimization-status",
      "final-timeline",
    ]) {
      expect(seen, `missing test id ${id}`).toContain(id);
    }

    await user.click(screen.getByRole("button", { name: "Back to review" }));
    expect(await screen.findByTestId("place-card")).toBeInTheDocument();
    expect(screen.queryByTestId("final-timeline")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View final schedule" }));
    expect(await screen.findByTestId("final-timeline")).toBeInTheDocument();
  });

  it("a test id appears only once on screen, including with a final schedule", async () => {
    const trip = validTrip(
      makeTrip({
        step: "final",
        places: [makePlace()],
        optimization: makeOptimization({ status: "solved", result: makeSchedule() }),
      }),
    );
    stubFetch({
      "GET /api/trips": jsonResponse([summary(trip)]),
      "GET /api/trips/t1": jsonResponse(trip),
    });
    renderUi(<App />, "/trips/t1");
    await screen.findByTestId("final-timeline");
    for (const id of ["new-trip", "trip-list", "steps-timeline", "optimization-status"]) {
      expect(screen.getAllByTestId(id)).toHaveLength(1);
    }
  });

  it("reload restores the trip and step from the server alone", async () => {
    const trip = validTrip(makeTrip({ step: "review", places: [makePlace()] }));
    stubFetch({
      "GET /api/trips": jsonResponse([summary(trip)]),
      "GET /api/trips/t1": jsonResponse(trip),
    });
    const first = renderUi(<App />, "/trips/t1");
    await screen.findByTestId("place-card");
    first.unmount();
    resetTripStore();
    renderUi(<App />, "/trips/t1");
    expect(await screen.findByTestId("place-card")).toBeInTheDocument();
    expect(document.querySelector('[data-step="review"]')).toHaveAttribute("data-state", "current");
  });

  it("a trip.updated event refetches, and the cards fill in progressively", async () => {
    const running = validTrip(
      makeTrip({
        step: "place_data",
        places: [makePlace({ status: "running", data: null, sources: [] })],
      }),
    );
    const done = validTrip({
      ...running,
      updatedAt: at(1),
      places: [makePlace()],
    });
    let current = running;
    stubFetch({
      "GET /api/trips": jsonResponse([summary(running)]),
      "GET /api/trips/t1": () => jsonResponse(current),
    });
    renderUi(<App />, "/trips/t1");
    const card = await screen.findByTestId("place-card");
    expect(card).toHaveAttribute("data-status", "running");
    current = done;
    act(() => FakeEventSource.instances[0]!.emit({ type: "trip.updated", tripId: "t1" }));
    await waitFor(() =>
      expect(screen.getByTestId("place-card")).toHaveAttribute("data-status", "done"),
    );
  });

  it("keeps moving by polling when the stream dies", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const before = validTrip(
      makeTrip({ step: "refinement", proposals: { status: "running", items: [], error: null } }),
    );
    const after = validTrip({
      ...before,
      updatedAt: at(1),
      proposals: { status: "failed", items: [], error: "Search failed." },
    });
    let current = before;
    stubFetch({
      "GET /api/trips": jsonResponse([summary(before)]),
      "GET /api/trips/t1": () => jsonResponse(current),
    });
    renderUi(<App />, "/trips/t1");
    await screen.findByText(/Searching the web/);
    current = after;
    act(() => FakeEventSource.instances[0]!.onerror?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    await waitFor(() => expect(screen.getByText(/Search failed\./)).toBeInTheDocument());
  });

  it("switching trips shows each trip's own chat and draft", async () => {
    const user = userEvent.setup();
    const a = validTrip(makeTrip({ id: "a", title: "Trip A" }));
    const b = validTrip(makeTrip({ id: "b", title: "Trip B" }));
    const { calls } = stubFetch({
      "GET /api/trips": jsonResponse([summary(a), summary(b)]),
      "GET /api/trips/a": jsonResponse(a),
      "GET /api/trips/b": jsonResponse(b),
      "GET /api/speech/status": jsonResponse(speech),
    });
    renderUi(<App />, "/trips/a");
    await user.type(await screen.findByTestId("chat-input"), "Draft for A");
    await user.click(screen.getByRole("link", { name: /Trip B/ }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/trips/b")).toBe(true));
    await waitFor(() => expect(screen.getByTestId("chat-input")).toHaveValue(""));
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(FakeEventSource.instances.at(-1)!.url).toBe("/api/trips/b/events");
    await user.click(screen.getByRole("link", { name: /Trip A/ }));
    await waitFor(() => expect(screen.getByTestId("chat-input")).toHaveValue("Draft for A"));
  });

  it("shows a missing trip, and a failed load with retry, as text", async () => {
    const user = userEvent.setup();
    let response = jsonResponse({ error: "Database down" }, 500);
    stubFetch({
      "GET /api/trips": jsonResponse([]),
      "GET /api/trips/x": () => response,
    });
    renderUi(<App />, "/trips/x");
    expect(await screen.findByText(/Could not load this trip: Database down/)).toBeInTheDocument();
    response = jsonResponse({ error: "Trip not found" }, 404);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/does not exist any more/)).toBeInTheDocument();
  });

  it("deleting the open trip asks first, then goes back to the landing page", async () => {
    const user = userEvent.setup();
    const trip = validTrip(makeTrip());
    const { calls } = stubFetch({
      "GET /api/trips": jsonResponse([summary(trip)]),
      "GET /api/trips/t1": jsonResponse(trip),
      "GET /api/speech/status": jsonResponse(speech),
      "DELETE /api/trips/t1": new Response(null, { status: 204 }),
    });
    renderUi(<App />, "/trips/t1");
    await screen.findByTestId("chat-input");
    await user.click(screen.getByRole("button", { name: "Delete Paris in May" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("button", { name: "Begin planning" })).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(screen.getByTestId("trip-list")).toBeEmptyDOMElement();
  });

  it("shows a failure to create a trip as text", async () => {
    const user = userEvent.setup();
    stubFetch({
      "GET /api/trips": jsonResponse([]),
      "POST /api/trips": jsonResponse({ error: "Database down" }, 500),
    });
    renderUi(<App />);
    await user.click(await screen.findByTestId("new-trip"));
    expect(await screen.findByText("Database down")).toBeInTheDocument();
  });

  it("the landing page shows the slogan and the trip list", async () => {
    const trip = validTrip(makeTrip());
    stubFetch({ "GET /api/trips": jsonResponse([summary(trip)]) });
    renderUi(<App />);
    expect(screen.getByTestId("slogan")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Paris in May/ })).toHaveAttribute(
      "href",
      "/trips/t1",
    );
  });
});
