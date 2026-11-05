import type { TripPlace, TripState } from "@triplanner/shared";
import { divIcon, latLngBounds, type Marker as LeafletMarker } from "leaflet";
import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, Marker, Popup, TileLayer, Tooltip, useMap } from "react-leaflet";
import { formatDate, formatTicket, hoursForTrip } from "../lib/format";
import { useTripStore } from "../store";
import { ErrorBoundary } from "./ErrorBoundary";

export const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

/** divIcon takes an HTML string, so every interpolated value has to be escaped. */
export const pinHtml = (id: string, name: string, label: string, active: boolean): string =>
  `<span data-testid="map-pin" data-place-id="${escapeHtml(id)}" data-active="${active}" ` +
  `role="img" aria-label="${escapeHtml(name)}" class="pin${active ? " pin--active" : ""}">` +
  `${escapeHtml(label)}</span>`;

interface Pin {
  place: TripPlace;
  lat: number;
  lng: number;
}

const pinOf = (place: TripPlace): Pin | null => {
  const lat = place.data?.lat;
  const lng = place.data?.lng;
  return lat == null || lng == null ? null : { place, lat, lng };
};

function PlaceInfo({ place, state }: { place: TripPlace; state: TripState }) {
  const data = place.data;
  const hours = data ? hoursForTrip(data, state) : [];
  return (
    <div>
      <strong>{data?.place ?? place.name}</strong>
      {hours.length > 0 ? (
        hours.slice(0, 3).map((entry) => (
          <div key={`${entry.date}-${entry.start}`}>
            {formatDate(entry.date)}: {entry.start}–{entry.end}
          </div>
        ))
      ) : (
        <div>Hours unknown</div>
      )}
      {data && data.tickets.length > 0 ? (
        data.tickets
          .slice(0, 3)
          .map((ticket, index) => <div key={index}>{formatTicket(ticket)}</div>)
      ) : (
        <div>Prices unknown</div>
      )}
    </div>
  );
}

function PinMarker({
  pin,
  label,
  active,
  state,
}: {
  pin: Pin;
  label: string;
  active: boolean;
  state: TripState;
}) {
  const markerRef = useRef<LeafletMarker>(null);
  const setSelected = useTripStore((s) => s.setSelected);
  const name = pin.place.data?.place ?? pin.place.name;
  const icon = useMemo(
    () =>
      divIcon({
        className: "pin-wrap",
        html: pinHtml(pin.place.id, name, label, active),
        iconSize: [26, 26],
        iconAnchor: [13, 13],
        popupAnchor: [0, -14],
        tooltipAnchor: [14, 0],
      }),
    [pin.place.id, name, label, active],
  );

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    try {
      if (active) marker.openPopup();
      else marker.closePopup();
    } catch {
      // A popup on a map that is being torn down is not worth failing over.
    }
  }, [active]);

  return (
    <Marker
      ref={markerRef}
      position={[pin.lat, pin.lng]}
      icon={icon}
      alt={name}
      eventHandlers={{ click: () => setSelected(pin.place.id) }}
    >
      <Tooltip>
        <PlaceInfo place={pin.place} state={state} />
      </Tooltip>
      <Popup>
        <PlaceInfo place={pin.place} state={state} />
      </Popup>
    </Marker>
  );
}

/** Fits the pins when the set changes and focuses the selected one. Layout never breaks on it. */
function MapController({ pins, focusId }: { pins: Pin[]; focusId: string | null }) {
  const map = useMap();
  const boundsKey = pins.map((pin) => `${pin.lat},${pin.lng}`).join(";");

  useEffect(() => {
    if (pins.length === 0) return;
    try {
      map.fitBounds(latLngBounds(pins.map((pin) => [pin.lat, pin.lng])), {
        padding: [36, 36],
        maxZoom: 15,
      });
    } catch {
      // A zero-sized container cannot be fitted. The next resize fixes the view.
    }
  }, [map, boundsKey]);

  useEffect(() => {
    const focus = pins.find((pin) => pin.place.id === focusId);
    if (!focus) return;
    try {
      map.setView([focus.lat, focus.lng], Math.max(map.getZoom(), 15));
    } catch {
      // See above.
    }
  }, [map, focusId]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);

  return null;
}

export function TripMap({
  places,
  state,
  labels = {},
}: {
  places: TripPlace[];
  state: TripState;
  /** Text inside a pin, by place id: the visit number in the final view. */
  labels?: Record<string, string>;
}) {
  const hoveredId = useTripStore((s) => s.hoveredPlaceId);
  const selectedId = useTripStore((s) => s.selectedPlaceId);
  const [tilesFailed, setTilesFailed] = useState(false);
  const pins = places.map(pinOf).filter((pin): pin is Pin => pin !== null);
  const offMap = places.filter((place) => pinOf(place) === null);
  const first = pins[0];

  return (
    <section
      aria-label="Trip map"
      style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", gap: 8, minHeight: 0 }}
    >
      {first ? (
        <ErrorBoundary fallback={(message) => <p role="alert">The map failed: {message}</p>}>
          <div className="map-frame">
            <MapContainer center={[first.lat, first.lng]} zoom={13} scrollWheelZoom>
              <TileLayer
                url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution="&copy; OpenStreetMap contributors"
                eventHandlers={{
                  tileerror: () => setTilesFailed(true),
                  tileload: () => setTilesFailed(false),
                }}
              />
              <MapController pins={pins} focusId={selectedId} />
              {pins.map((pin) => (
                <PinMarker
                  key={pin.place.id}
                  pin={pin}
                  label={labels[pin.place.id] ?? ""}
                  active={hoveredId === pin.place.id || selectedId === pin.place.id}
                  state={state}
                />
              ))}
            </MapContainer>
          </div>
        </ErrorBoundary>
      ) : (
        <p className="eyebrow">Pins appear here once places have coordinates.</p>
      )}
      {tilesFailed && (
        <p role="status" className="eyebrow" style={{ margin: 0 }}>
          Map tiles could not load. The pins are still placed correctly.
        </p>
      )}
      {offMap.length > 0 && (
        <div data-testid="not-on-map">
          <div className="eyebrow">Not on map</div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {offMap.map((place) => (
              <li key={place.id}>
                {place.data?.place ?? place.name}
                {place.status === "queued" || place.status === "running"
                  ? " (still being looked up)"
                  : place.status === "failed"
                    ? " (lookup failed)"
                    : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
