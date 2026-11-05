import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { Trip } from "@triplanner/shared";
import { OPTIMIZATION_STATUSES } from "@triplanner/shared";
import { resetTripStore, useTripStore } from "../store";
import { makeOptimization, makePlace, makeState, makeTrip } from "../test/fixtures";
import { renderUi } from "../test/render";
import { StepsTimeline } from "./StepsTimeline";

const states = (container: HTMLElement) =>
  Object.fromEntries(
    Array.from(container.querySelectorAll("[data-step]")).map((el) => [
      el.getAttribute("data-step"),
      el.getAttribute("data-state"),
    ]),
  );

const show = (trip: Trip) => renderUi(<StepsTimeline trip={trip} />);

beforeEach(() => resetTripStore());

describe("StepsTimeline", () => {
  it("has five labelled items for steps 0, 1, 2, 3, 5 and none for step 4", () => {
    show(makeTrip());
    const timeline = screen.getByTestId("steps-timeline");
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(5);
    for (const text of ["Step 0", "Step 1", "Step 2", "Step 3", "Step 5"]) {
      expect(within(timeline).getByText(text)).toBeInTheDocument();
    }
    expect(within(timeline).queryByText("Step 4")).not.toBeInTheDocument();
    expect(within(timeline).getByText("Trip intake")).toBeInTheDocument();
  });

  it("marks the current step and the upcoming ones", () => {
    show(makeTrip());
    expect(states(screen.getByTestId("steps-timeline"))).toEqual({
      intake: "current",
      refinement: "upcoming",
      place_data: "upcoming",
      review: "upcoming",
      final: "upcoming",
    });
    expect(screen.getAllByText("upcoming")).toHaveLength(4);
  });

  it("shows step 1 as skipped when no search was needed", () => {
    show(makeTrip({ step: "place_data", state: makeState({ needs_search: false }) }));
    expect(states(screen.getByTestId("steps-timeline"))).toMatchObject({
      intake: "complete",
      refinement: "skipped",
      place_data: "current",
    });
    expect(screen.getByText("skipped")).toBeInTheDocument();
  });

  it("shows step 1 as complete after a real search", () => {
    show(
      makeTrip({
        step: "final",
        state: makeState({ needs_search: true }),
        proposals: { status: "ready", items: [], error: null },
      }),
    );
    expect(states(screen.getByTestId("steps-timeline"))).toEqual({
      intake: "complete",
      refinement: "complete",
      place_data: "complete",
      review: "complete",
      final: "current",
    });
  });

  it.each(OPTIMIZATION_STATUSES)("shows optimization status %s inside item 3", (status) => {
    show(makeTrip({ step: "review", optimization: makeOptimization({ status }) }));
    const item = screen.getByTestId("steps-timeline").querySelector('[data-step="review"]');
    expect(within(item as HTMLElement).getByTestId("timeline-optimization")).toHaveTextContent(
      `schedule optimization: ${status}`,
    );
  });

  it("shows a place progress count on item 2", () => {
    show(
      makeTrip({
        step: "place_data",
        places: [makePlace({ id: "a" }), makePlace({ id: "b", status: "running", data: null })],
      }),
    );
    expect(screen.getByText(/1 of 2 ready/)).toBeInTheDocument();
  });

  it("has a help tooltip on hover", async () => {
    const user = userEvent.setup();
    show(makeTrip());
    await user.hover(screen.getByText("Place refinement"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/Skipped when you named/);
  });

  it("lets the user go back to a reached step, but not forward", async () => {
    const user = userEvent.setup();
    show(makeTrip({ step: "review" }));
    await user.click(screen.getByRole("button", { name: "Trip intake" }));
    expect(useTripStore.getState().viewOverride).toBe("intake");
    expect(screen.queryByRole("button", { name: "Final view" })).not.toBeInTheDocument();
  });
});
