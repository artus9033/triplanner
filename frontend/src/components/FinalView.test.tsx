import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { resetTripStore, useTripStore } from "../store";
import {
  jsonResponse,
  makeItem,
  makeOptimization,
  makePlace,
  makeSchedule,
  makeTrip,
  stubFetch,
} from "../test/fixtures";
import { renderUi } from "../test/render";
import { FinalView, visitLabels } from "./FinalView";

const items = [
  makeItem({
    placeId: "b",
    name: "Second day visit",
    day: 2,
    date: "2026-05-13",
    order: 1,
    slack: 0,
    startLabel: "10:00",
    endLabel: "11:30",
    travelFromPrevMin: 5,
    ticket: { kind: "free", price: 0, label: null },
  }),
  makeItem({ placeId: "a2", name: "Later first day", order: 2, slack: 60, travelFromPrevMin: 12 }),
  makeItem({ placeId: "louvre", name: "Louvre Museum", order: 1, slack: 30, travelFromPrevMin: 0 }),
];

const trip = (scheduleOverrides = {}) =>
  makeTrip({
    step: "final",
    places: [
      makePlace(),
      makePlace({
        id: "a2",
        name: "No reservation",
        data: { ...makePlace().data!, needs_reservation: false },
      }),
      makePlace({ id: "b", name: "Second" }),
    ],
    optimization: makeOptimization({
      status: "solved",
      result: makeSchedule({ items, ...scheduleOverrides }),
    }),
  });

const show = (t = trip()) => {
  useTripStore.getState().applyTrip(t);
  return renderUi(<FinalView trip={t} />);
};

beforeEach(() => resetTripStore());

describe("FinalView", () => {
  it("has one timeline item per visit, in order, under date separators", () => {
    show();
    const timeline = screen.getByTestId("final-timeline");
    expect(screen.getAllByTestId("final-item")).toHaveLength(3);
    expect(screen.getAllByTestId("final-day").map((d) => d.textContent)).toEqual([
      "Day 1 Tue 12 May 2026",
      "Day 2 Wed 13 May 2026",
    ]);
    const order = Array.from(
      timeline.querySelectorAll("[data-testid=final-item], [data-testid=final-day]"),
    ).map((el) => el.getAttribute("data-place-id") ?? "day");
    expect(order).toEqual(["day", "louvre", "a2", "day", "b"]);
  });

  it("shows times, ticket, price, travel and mode", () => {
    show();
    const [first, second, third] = screen.getAllByTestId("final-item");
    expect(first).toHaveTextContent("09:00–11:00");
    expect(first).toHaveTextContent("$22, paid (Adult)");
    expect(within(first!).getByTestId("travel-leg")).toHaveTextContent(/^$/);
    expect(within(second!).getByTestId("travel-leg")).toHaveTextContent("12 min walking");
    expect(third).toHaveTextContent("Free");
  });

  it("shows the reservation badge only where needed", () => {
    show();
    const [first, second] = screen.getAllByTestId("final-item");
    expect(within(first!).getByText("Reservation needed")).toBeInTheDocument();
    expect(within(second!).queryByText(/eservation/)).not.toBeInTheDocument();
  });

  it("draws slack proportional to its size, and marks zero slack as tight", async () => {
    const user = userEvent.setup();
    show();
    const [first, second, third] = screen.getAllByTestId("final-item");
    expect(within(first!).getByTestId("slack-band")).toHaveStyle({ width: "50%" });
    expect(within(second!).getByTestId("slack-band")).toHaveStyle({ width: "100%" });
    expect(within(third!).getByText("tight")).toBeInTheDocument();
    expect(within(third!).queryByTestId("slack-band")).not.toBeInTheDocument();
    expect(within(first!).queryByText("tight")).not.toBeInTheDocument();

    await user.hover(within(first!).getByTestId("slack-track"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("can start up to 30 min later");
  });

  it("hovering an item sets the pin highlight, and leaving clears it", async () => {
    const user = userEvent.setup();
    show();
    const [first] = screen.getAllByTestId("final-item");
    await user.hover(first!);
    expect(useTripStore.getState().hoveredPlaceId).toBe("louvre");
    await user.unhover(first!);
    expect(useTripStore.getState().hoveredPlaceId).toBeNull();
  });

  it("clicking an item opens its place and ticket details and focuses the map", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: /Louvre Museum/ }));
    const details = await screen.findByRole("region", { name: "Details for Louvre Museum" });
    expect(details).toHaveTextContent("Your ticket: $22, paid (Adult)");
    expect(details).toHaveTextContent("Rue de Rivoli, Paris");
    expect(details).toHaveTextContent("paid · 22EUR · under 18 free");
    expect(useTripStore.getState().selectedPlaceId).toBe("louvre");

    await user.click(screen.getByRole("button", { name: /Louvre Museum/ }));
    expect(useTripStore.getState().selectedPlaceId).toBeNull();
  });

  it("summarizes the totals", () => {
    show();
    const text = document.querySelector(".summary")?.textContent ?? "";
    expect(text).toContain("1 h 35 min");
    expect(text).toContain("$22 of $100");
    expect(text).toContain("1 of 2");
    expect(text).toContain("optimal");
  });

  it("handles no budget limit, and the good and heuristic labels", () => {
    const base = makeSchedule().totals;
    const first = show(trip({ quality: "good", totals: { ...base, budget: null } }));
    let text = document.querySelector(".summary")?.textContent ?? "";
    expect(text).toContain("no budget limit");
    expect(text).toContain("good schedule");
    first.unmount();
    show(trip({ quality: "heuristic" }));
    text = document.querySelector(".summary")?.textContent ?? "";
    expect(text).toContain("heuristic");
  });

  it("keeps 'not included' collapsed, and 'try to fit this in' posts the force request", async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({ "POST /api/trips/t1/optimize": jsonResponse(trip()) });
    show(
      trip({
        dropped: [
          {
            placeId: "orsay",
            name: "Orsay",
            must: false,
            reason: "lower_priority",
            detail: "Ran out of time.",
          },
        ],
      }),
    );
    expect(screen.queryByText("Ran out of time.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Not included (1)" }));
    expect(await screen.findByText("Ran out of time.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try to fit this in" }));
    expect(calls[0]?.body).toEqual({ forcePlaceIds: ["orsay"], allowShortening: true });
  });

  it("has no 'not included' section when nothing was dropped", () => {
    show();
    expect(screen.queryByText(/Not included/)).not.toBeInTheDocument();
  });

  it("has a way back to the review view", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "Back to review" }));
    expect(useTripStore.getState().viewOverride).toBe("review");
  });

  it("has the diagnostics panel in dev", () => {
    show();
    expect(screen.getByTestId("diagnostics")).toHaveTextContent("highs");
  });

  it("shows progress and no timeline while a re-solve has no result yet", () => {
    show(makeTrip({ step: "final", optimization: makeOptimization({ status: "running" }) }));
    expect(screen.getByTestId("optimization-status")).toHaveTextContent("running");
    expect(screen.queryByTestId("final-timeline")).not.toBeInTheDocument();
  });

  it("numbers pins in trip order across days", () => {
    expect(visitLabels(makeSchedule({ items }))).toEqual({ louvre: "1", a2: "2", b: "3" });
  });
});
