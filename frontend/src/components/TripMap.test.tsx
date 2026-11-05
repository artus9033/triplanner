import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetTripStore, useTripStore } from "../store";
import { makePlace, makeState } from "../test/fixtures";
import { renderUi } from "../test/render";
import { escapeHtml, pinHtml, TripMap } from "./TripMap";

const places = () => [
  makePlace(),
  makePlace({
    id: "orsay",
    name: "Orsay",
    data: { ...makePlace().data!, place: "Musee d'Orsay", lat: 48.86, lng: 2.3266 },
  }),
];

const show = (list = places(), labels = {}) =>
  renderUi(<TripMap places={list} state={makeState()} labels={labels} />);

beforeEach(() => resetTripStore());

describe("pinHtml", () => {
  it("carries the test id and escapes everything interpolated", () => {
    const html = pinHtml('a"b', "<img src=x onerror=alert(1)>", "<b>", true);
    expect(html).toContain('data-testid="map-pin"');
    expect(html).toContain("pin--active");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("a&quot;b");
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("TripMap with real Leaflet in jsdom", () => {
  it("renders one map-pin per place with coordinates", async () => {
    show();
    await waitFor(() => expect(screen.getAllByTestId("map-pin")).toHaveLength(2));
    expect(screen.getByRole("img", { name: "Musee d'Orsay" })).toBeInTheDocument();
  });

  it("shows pin labels", async () => {
    show(places(), { louvre: "1", orsay: "2" });
    await waitFor(() => expect(screen.getAllByTestId("map-pin")).toHaveLength(2));
    expect(screen.getAllByTestId("map-pin").map((pin) => pin.textContent)).toEqual(["1", "2"]);
  });

  it("escapes a hostile place name inside the pin", async () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const { container } = show([makePlace({ data: { ...makePlace().data!, place: evil } })]);
    await waitFor(() => expect(screen.getByTestId("map-pin")).toBeInTheDocument());
    expect(container.querySelector(".leaflet-marker-icon img")).toBeNull();
    expect(screen.getByRole("img", { name: evil })).toBeInTheDocument();
  });

  it("highlights the hovered place's pin and opens its popup", async () => {
    const { container } = show();
    await waitFor(() => expect(screen.getAllByTestId("map-pin")).toHaveLength(2));
    act(() => useTripStore.getState().setHovered("orsay"));
    await waitFor(() => {
      const active = container.querySelector('[data-testid="map-pin"][data-active="true"]');
      expect(active).toHaveAttribute("data-place-id", "orsay");
    });
    await waitFor(() =>
      expect(container.querySelector(".leaflet-popup-content")).toHaveTextContent("Musee d'Orsay"),
    );
    act(() => useTripStore.getState().setHovered(null));
    await waitFor(() =>
      expect(container.querySelector('[data-testid="map-pin"][data-active="true"]')).toBeNull(),
    );
  });

  it("the popup holds name, hours and price info, as text", async () => {
    const { container } = show();
    await waitFor(() => expect(screen.getAllByTestId("map-pin")).toHaveLength(2));
    act(() => useTripStore.getState().setHovered("louvre"));
    await waitFor(() => {
      const popup = container.querySelector(".leaflet-popup-content");
      expect(popup).toHaveTextContent("Louvre Museum");
      expect(popup).toHaveTextContent("09:00–18:00");
      expect(popup).toHaveTextContent("22EUR");
    });
  });

  it("selecting a place focuses the map without breaking", async () => {
    show();
    await waitFor(() => expect(screen.getAllByTestId("map-pin")).toHaveLength(2));
    act(() => useTripStore.getState().setSelected("louvre"));
    await waitFor(() =>
      expect(document.querySelector('[data-active="true"]')).toHaveAttribute(
        "data-place-id",
        "louvre",
      ),
    );
  });

  it("lists places without coordinates as not on map", () => {
    show([
      makePlace(),
      makePlace({
        id: "noloc",
        data: { ...makePlace().data!, place: "No coordinates", lat: null, lng: null },
      }),
      makePlace({ id: "busy", name: "Still running", status: "running", data: null }),
      makePlace({ id: "bad", name: "Broken", status: "failed", data: null }),
    ]);
    const list = screen.getByTestId("not-on-map");
    expect(list).toHaveTextContent("Not on map");
    expect(list).toHaveTextContent("No coordinates");
    expect(list).toHaveTextContent("Still running (still being looked up)");
    expect(list).toHaveTextContent("Broken (lookup failed)");
  });

  it("renders text instead of a map when no place has coordinates", () => {
    const { container } = show([makePlace({ status: "queued", data: null })]);
    expect(container.querySelector(".leaflet-container")).toBeNull();
    expect(screen.getByText(/Pins appear here/)).toBeInTheDocument();
  });
});
