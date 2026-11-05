import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { TripPlace } from "@triplanner/shared";
import { resetTripStore, useTripStore } from "../store";
import { jsonResponse, makePlace, makeState, makeTrip, stubFetch } from "../test/fixtures";
import { renderUi } from "../test/render";
import { PlaceCard } from "./PlaceCard";

const show = (place: TripPlace) =>
  renderUi(<PlaceCard tripId="t1" place={place} state={makeState()} />);

const withData = (patch: Partial<NonNullable<TripPlace["data"]>>) => {
  const base = makePlace();
  return makePlace({ data: { ...base.data!, ...patch } });
};

beforeEach(() => resetTripStore());

describe("PlaceCard", () => {
  it("shows queued", () => {
    show(makePlace({ status: "queued", data: null, sources: [] }));
    const card = screen.getByTestId("place-card");
    expect(card).toHaveAttribute("data-status", "queued");
    expect(within(card).getByText("queued")).toBeInTheDocument();
    expect(within(card).getByText("Louvre")).toBeInTheDocument();
  });

  it("shows running with progress", () => {
    show(makePlace({ status: "running", data: null, sources: [] }));
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("shows a failure with its text, and retries the place", async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({
      "POST /api/trips/t1/places/louvre/retry": jsonResponse(makeTrip()),
    });
    show(makePlace({ status: "failed", data: null, error: "Timed out after 1 minute." }));
    expect(screen.getByText("Timed out after 1 minute.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry this place" }));
    expect(calls[0]?.path).toBe("/api/trips/t1/places/louvre/retry");
  });

  it("shows a failed retry as text", async () => {
    const user = userEvent.setup();
    stubFetch({
      "POST /api/trips/t1/places/louvre/retry": jsonResponse({ error: "Not allowed now" }, 409),
    });
    show(makePlace({ status: "failed", data: null, error: "x" }));
    await user.click(screen.getByRole("button", { name: "Retry this place" }));
    expect(await screen.findByText("Not allowed now")).toBeInTheDocument();
  });

  it("shows all the details when done, with hours only for the trip's dates", () => {
    show(makePlace());
    const card = screen.getByTestId("place-card");
    for (const text of [
      "museum",
      "Rue de Rivoli, Paris",
      "Home of the Mona Lisa.",
      "+33 1 40 20 53 17",
      "Reservation needed",
      "Tue 12 May 2026: 09:00–18:00",
      "paid · 22EUR · under 18 free",
    ]) {
      expect(within(card).getByText(text)).toBeInTheDocument();
    }
    expect(within(card).queryByText(/20 May/)).not.toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "louvre.fr" })).toHaveAttribute(
      "href",
      "https://www.louvre.fr/",
    );
    const source = within(card).getByRole("link", { name: "Plan your visit" });
    expect(source).toHaveAttribute("rel", "noopener noreferrer");
    expect(source).toHaveAttribute("target", "_blank");
  });

  it("uses a reservation badge for each of true, false and unknown", () => {
    const first = show(withData({ needs_reservation: false }));
    expect(screen.getByText("No reservation needed")).toBeInTheDocument();
    first.unmount();
    show(withData({ needs_reservation: null }));
    expect(screen.getByText("Reservation unknown")).toBeInTheDocument();
  });

  it("hides the image when it fails to load, and when its URL is unsafe", () => {
    const first = show(makePlace());
    fireEvent.error(screen.getByRole("img", { name: "Louvre Museum" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    first.unmount();
    show(withData({ place_image_url: "javascript:alert(1)" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("keeps HTML in web-derived text literal", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const { container } = show(
      makePlace({
        name: evil,
        note: `<script>${evil}</script>`,
        data: { ...makePlace().data!, place: `Name ${evil}`, description: evil, address: evil },
        sources: [{ url: "https://ok.example.com/", title: evil }],
      }),
    );
    expect(screen.getAllByText(evil).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(`Name ${evil}`)).toBeInTheDocument();
    expect(container.querySelector('img[onerror], img[src="x"], script')).toBeNull();
  });

  it("keeps HTML in a failure message literal", () => {
    const evil = "<b onclick=alert(1)>boom</b>";
    const { container } = show(makePlace({ status: "failed", data: null, error: evil }));
    expect(screen.getByText(evil)).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
  });

  it("does not render javascript: links", () => {
    const { container } = show(
      makePlace({
        data: {
          ...makePlace().data!,
          website: "javascript:alert(1)",
          google_maps_url: "data:text/html,x",
        },
        sources: [{ url: "javascript:alert(2)", title: "Evil source" }],
      }),
    );
    expect(screen.queryByText("Evil source")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.querySelector('a[href^="javascript"], a[href^="data"]')).toBeNull();
  });

  it("highlights its pin while hovered", async () => {
    const user = userEvent.setup();
    show(makePlace());
    await user.hover(screen.getByTestId("place-card"));
    expect(useTripStore.getState().hoveredPlaceId).toBe("louvre");
    await user.unhover(screen.getByTestId("place-card"));
    expect(useTripStore.getState().hoveredPlaceId).toBeNull();
  });
});
