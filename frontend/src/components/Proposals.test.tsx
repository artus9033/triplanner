import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { PlaceProposal, Proposals as ProposalsType } from "@triplanner/shared";
import { resetTripStore, useTripStore } from "../store";
import { jsonResponse, makeState, makeTrip, stubFetch } from "../test/fixtures";
import { renderUi } from "../test/render";
import { Proposals } from "./Proposals";

const proposal = (id: string, overrides: Partial<PlaceProposal> = {}): PlaceProposal => ({
  id,
  name: `Gallery ${id}`,
  category: "gallery",
  why: `Because of ${id}`,
  link: `https://example.com/${id}`,
  link_kind: "website",
  sources: [{ url: "https://sources.example.com/", title: "A source" }],
  ...overrides,
});

const trip = (proposals: Partial<ProposalsType>, named: string[] = []) =>
  makeTrip({
    step: "refinement",
    state: makeState({
      needs_search: true,
      named_places: named.map((name) => ({ name, note: null })),
    }),
    proposals: { status: "ready", items: [], error: null, ...proposals },
  });

const Connected = () => {
  const current = useTripStore((s) => s.trips.t1)!;
  return <Proposals trip={current} />;
};

const show = (t: ReturnType<typeof trip>) => {
  useTripStore.getState().applyTrip(t);
  return renderUi(<Connected />);
};

beforeEach(() => resetTripStore());

describe("Proposals", () => {
  it("shows progress while searching, including before the search starts", () => {
    show(trip({ status: "running" }));
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByText(/Searching the web/)).toBeInTheDocument();
    expect(screen.queryByTestId("places-confirm")).not.toBeInTheDocument();
  });

  it("shows the error and retries on failure", async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({
      "POST /api/trips/t1/proposals/retry": jsonResponse(
        makeTrip({
          step: "refinement",
          updatedAt: "2026-02-01T00:00:00.000Z",
          proposals: { status: "running", items: [], error: null },
        }),
      ),
    });
    show(trip({ status: "failed", error: "Web search is disabled." }));
    expect(screen.getByText(/Web search is disabled\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry search" }));
    expect(calls[0]?.path).toBe("/api/trips/t1/proposals/retry");
    expect(await screen.findByText(/Searching the web/)).toBeInTheDocument();
  });

  it("each option has a labelled checkbox, the reason, and exactly one safe link", () => {
    show(trip({ items: [proposal("a"), proposal("b", { link_kind: "google_maps" })] }));
    const options = screen.getAllByTestId("place-option");
    expect(options).toHaveLength(2);
    const first = within(options[0]!);
    expect(first.getByRole("checkbox", { name: "Gallery a" })).not.toBeChecked();
    expect(first.getByText("Because of a")).toBeInTheDocument();
    const links = first.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://example.com/a");
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(options[1]!).getByRole("link")).toHaveTextContent("Google Maps");
  });

  it("does not render an unsafe link", () => {
    show(trip({ items: [proposal("a", { link: "javascript:alert(1)" })] }));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Gallery a" })).toBeInTheDocument();
  });

  it("disables confirm with a visible reason when nothing is selected or named", async () => {
    const user = userEvent.setup();
    show(trip({ items: [proposal("a")] }));
    expect(screen.getByTestId("places-confirm")).toBeDisabled();
    expect(screen.getByText("Select at least one place to continue.")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Gallery a" }));
    expect(screen.getByTestId("places-confirm")).toBeEnabled();
    expect(screen.queryByText("Select at least one place to continue.")).not.toBeInTheDocument();
  });

  it("allows confirming with no selection when places were named", async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({
      "POST /api/trips/t1/proposals/confirm": jsonResponse(makeTrip({ step: "place_data" })),
    });
    show(trip({ items: [proposal("a")] }, ["Louvre"]));
    expect(screen.getByText(/Louvre/)).toBeInTheDocument();
    await user.click(screen.getByTestId("places-confirm"));
    expect(calls[0]?.body).toEqual({ placeIds: [] });
  });

  it("confirms the selected ids in on-screen order", async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({
      "POST /api/trips/t1/proposals/confirm": jsonResponse(makeTrip({ step: "place_data" })),
    });
    show(trip({ items: [proposal("a"), proposal("b"), proposal("c")] }));
    await user.click(screen.getByLabelText("Gallery c"));
    await user.click(screen.getByLabelText("Gallery b"));
    await user.click(screen.getByLabelText("Gallery a"));
    await user.click(screen.getByLabelText("Gallery b"));
    await user.click(screen.getByTestId("places-confirm"));
    expect(calls[0]?.body).toEqual({ placeIds: ["a", "c"] });
  });

  it("shows a failed confirm as text", async () => {
    const user = userEvent.setup();
    stubFetch({
      "POST /api/trips/t1/proposals/confirm": jsonResponse({ error: "Unknown place id" }, 400),
    });
    show(trip({ items: [proposal("a")] }));
    await user.click(screen.getByLabelText("Gallery a"));
    await user.click(screen.getByTestId("places-confirm"));
    expect(await screen.findByText("Unknown place id")).toBeInTheDocument();
  });
});
