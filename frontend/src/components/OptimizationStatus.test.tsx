import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { OPTIMIZATION_STATUSES, type DroppedPlace } from "@triplanner/shared";
import { resetTripStore, useTripStore } from "../store";
import {
  jsonResponse,
  makeOptimization,
  makeSchedule,
  makeTrip,
  stubFetch,
} from "../test/fixtures";
import { renderUi } from "../test/render";
import { OptimizationStatus } from "./OptimizationStatus";

const dropped: DroppedPlace = {
  placeId: "orsay",
  name: "Orsay",
  must: true,
  reason: "closed_on_trip_dates",
  detail: "Closed on Mondays.",
};

const reviewTrip = (optimization: Parameters<typeof makeOptimization>[0]) =>
  makeTrip({ step: "review", optimization: makeOptimization(optimization) });

const show = (trip: ReturnType<typeof makeTrip>) => {
  useTripStore.getState().applyTrip(trip);
  return renderUi(<OptimizationStatus trip={trip} />);
};

const updated = (step: "review" | "final" = "review") =>
  jsonResponse(makeTrip({ step, updatedAt: "2026-02-01T00:00:00.000Z" }));

beforeEach(() => resetTripStore());

describe("OptimizationStatus", () => {
  it.each(OPTIMIZATION_STATUSES)("shows the literal word %s as visible text", (status) => {
    show(reviewTrip({ status, result: status === "solved" ? makeSchedule() : null }));
    const panel = screen.getByTestId("optimization-status");
    expect(panel).toHaveAttribute("data-status", status);
    expect(screen.getByText(status)).toBeVisible();
  });

  it.each(["pending", "running"] as const)("shows progress for %s", (status) => {
    show(reviewTrip({ status }));
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("says optimal or good schedule from the result's quality", () => {
    const first = show(reviewTrip({ status: "solved", result: makeSchedule() }));
    expect(screen.getByTestId("optimization-status")).toHaveTextContent("optimal");
    first.unmount();
    show(reviewTrip({ status: "solved", result: makeSchedule({ quality: "good" }) }));
    expect(screen.getByTestId("optimization-status")).toHaveTextContent("good schedule");
  });

  it("explains a fallback with its reason", () => {
    const base = makeSchedule();
    show(
      reviewTrip({
        status: "fallback",
        result: makeSchedule({
          quality: "heuristic",
          diagnostics: { ...base.diagnostics, fallbackReason: "AMPL is not installed." },
        }),
      }),
    );
    const panel = screen.getByTestId("optimization-status");
    expect(panel).toHaveTextContent("heuristic");
    expect(panel).toHaveTextContent("AMPL is not installed.");
  });

  it("shows a failure's error and can run again", async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({ "POST /api/trips/t1/optimize": updated() });
    show(reviewTrip({ status: "failed", error: "Solver crashed." }));
    expect(screen.getByText("Solver crashed.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run the optimizer again" }));
    expect(calls[0]?.body).toEqual({});
  });

  describe("infeasible", () => {
    const infeasible = () =>
      reviewTrip({ status: "infeasible", result: makeSchedule({ dropped: [dropped] }) });

    it("lists what was dropped, with its detail", () => {
      show(infeasible());
      expect(screen.getByText("Orsay")).toBeInTheDocument();
      expect(screen.getByText("Closed on Mondays.")).toBeInTheDocument();
    });

    it.each([
      ["Widen the day", { dayWindow: { start: "08:00", end: "22:00" } }],
      ["Extend the dates", { endDate: "2026-05-14" }],
      ["Drop Orsay", { dropPlaceIds: ["orsay"] }],
      ["Allow shorter visits", { allowShortening: true }],
    ])("%s posts its request", async (name, body) => {
      const user = userEvent.setup();
      const { calls } = stubFetch({ "POST /api/trips/t1/optimize": updated() });
      show(infeasible());
      await user.click(screen.getByRole("button", { name }));
      expect(calls[0]?.body).toEqual(body);
    });

    it("sends the edited day window", async () => {
      const user = userEvent.setup();
      const { calls } = stubFetch({ "POST /api/trips/t1/optimize": updated() });
      show(infeasible());
      const start = screen.getByLabelText("Day starts");
      await user.clear(start);
      await user.type(start, "07:30");
      await user.click(screen.getByRole("button", { name: "Widen the day" }));
      expect(calls[0]?.body).toEqual({ dayWindow: { start: "07:30", end: "22:00" } });
    });

    it("starts from the solver options the trip already has", () => {
      show({
        ...infeasible(),
        solverOptions: { dayWindow: { start: "07:00", end: "23:00" }, allowShortening: true },
      });
      expect(screen.getByLabelText("Day starts")).toHaveValue("07:00");
      expect(screen.getByLabelText("Day ends")).toHaveValue("23:00");
      expect(
        screen.queryByRole("button", { name: "Allow shorter visits" }),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Shorter visits are already allowed.")).toBeInTheDocument();
    });

    it("shows a failed request as text", async () => {
      const user = userEvent.setup();
      stubFetch({ "POST /api/trips/t1/optimize": jsonResponse({ error: "Busy" }, 409) });
      show(infeasible());
      await user.click(screen.getByRole("button", { name: "Allow shorter visits" }));
      expect(await screen.findByText("Busy")).toBeInTheDocument();
    });
  });

  describe("View final schedule", () => {
    it("is absent without a result", () => {
      show(reviewTrip({ status: "failed", error: "x" }));
      expect(screen.queryByRole("button", { name: "View final schedule" })).not.toBeInTheDocument();
    });

    it.each(["solved", "fallback", "infeasible"] as const)("finalizes from %s", async (status) => {
      const user = userEvent.setup();
      const { calls } = stubFetch({ "POST /api/trips/t1/finalize": updated("final") });
      show(reviewTrip({ status, result: makeSchedule() }));
      await user.click(screen.getByRole("button", { name: "View final schedule" }));
      expect(calls.map((c) => c.path)).toEqual(["/api/trips/t1/finalize"]);
    });

    it("on an already final trip only switches back, without another POST", async () => {
      const user = userEvent.setup();
      const { calls } = stubFetch({});
      useTripStore.setState({ viewOverride: "review" });
      show(
        makeTrip({
          step: "final",
          optimization: makeOptimization({ status: "solved", result: makeSchedule() }),
        }),
      );
      await user.click(screen.getByRole("button", { name: "View final schedule" }));
      expect(calls).toHaveLength(0);
      expect(useTripStore.getState().viewOverride).toBeNull();
    });
  });
});
