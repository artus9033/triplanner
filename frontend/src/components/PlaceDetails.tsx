import { Chip, Stack } from "@mui/material";
import type { TripPlace, TripState } from "@triplanner/shared";
import { formatDate, formatTicket, hoursForTrip, hoursNote } from "../lib/format";
import { safeHttpUrl, urlHost } from "../lib/safeUrl";
import { ExternalLink } from "./ExternalLink";
import type { ReactNode } from "react";
import { useState } from "react";

export const ReservationBadge = ({ needed }: { needed: boolean | null | undefined }) => {
  if (needed === true) {
    return <Chip size="small" color="warning" label="Reservation needed" />;
  }
  if (needed === false) {
    return <Chip size="small" variant="outlined" label="No reservation needed" />;
  }
  return <Chip size="small" variant="outlined" label="Reservation unknown" />;
};

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="field">
    <dt className="eyebrow">{label}</dt>
    <dd>{children}</dd>
  </div>
);

function PlaceImage({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  const safe = safeHttpUrl(src);
  if (!safe || failed) return null;
  return (
    <img
      className="place-image"
      src={safe}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

/** Everything a bot found about a place. All of it is web-derived: plain text, safe links only. */
export function PlaceDetails({ place, state }: { place: TripPlace; state: TripState }) {
  const data = place.data;
  if (!data) return <p>No details were found for this place.</p>;
  const hours = hoursForTrip(data, state);
  const sources = place.sources.filter((source) => safeHttpUrl(source.url) !== null);

  return (
    <div>
      <PlaceImage src={data.place_image_url} alt={data.place} />
      <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: "wrap", mb: 1 }}>
        <Chip size="small" variant="outlined" label={data.category} />
        <ReservationBadge needed={data.needs_reservation} />
      </Stack>
      {data.description && <div className="plain-text">{data.description}</div>}
      <dl style={{ margin: "8px 0 0" }}>
        <Field label="Address">{data.address ?? "Not found"}</Field>
        <Field label="Hours">
          {hours.length === 0 ? (
            hoursNote(data)
          ) : (
            <ul>
              {hours.map((entry) => (
                <li key={`${entry.date}-${entry.start}`}>
                  {formatDate(entry.date)}: {entry.start}–{entry.end}
                </li>
              ))}
            </ul>
          )}
        </Field>
        <Field label="Tickets">
          {data.tickets.length === 0 ? (
            "No ticket information found"
          ) : (
            <ul>
              {data.tickets.map((ticket, index) => (
                <li key={index}>{formatTicket(ticket)}</li>
              ))}
            </ul>
          )}
        </Field>
        {data.phone && <Field label="Phone">{data.phone}</Field>}
        {safeHttpUrl(data.website) && (
          <Field label="Website">
            <ExternalLink href={data.website}>{urlHost(safeHttpUrl(data.website)!)}</ExternalLink>
          </Field>
        )}
        {safeHttpUrl(data.google_maps_url) && (
          <Field label="Map">
            <ExternalLink href={data.google_maps_url}>Google Maps</ExternalLink>
          </Field>
        )}
        {sources.length > 0 && (
          <Field label="Sources">
            <ul>
              {sources.map((source) => (
                <li key={source.url}>
                  <ExternalLink href={source.url}>
                    {source.title || urlHost(safeHttpUrl(source.url)!)}
                  </ExternalLink>
                </li>
              ))}
            </ul>
          </Field>
        )}
      </dl>
    </div>
  );
}
