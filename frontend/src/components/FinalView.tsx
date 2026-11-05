import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Timeline,
  TimelineConnector,
  TimelineContent,
  TimelineDot,
  TimelineItem,
  TimelineOppositeContent,
  TimelineSeparator,
  timelineItemClasses,
  timelineOppositeContentClasses,
} from "@mui/lab";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Button,
  Chip,
  Collapse,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { DroppedPlace, ScheduleItem, Trip, TripSchedule } from "@triplanner/shared";
import { Fragment } from "react";
import {
  dropReasonText,
  formatDate,
  formatDuration,
  formatMoney,
  formatScheduledTicket,
  qualityText,
} from "../lib/format";
import { useAction } from "../lib/useAction";
import { useTripStore } from "../store";
import { OptimizationStatus } from "./OptimizationStatus";
import { PlaceDetails, ReservationBadge } from "./PlaceDetails";

/** The schedule does not carry its mode. The optimizer's TRANSPORT_MODE default is walking. */
const TRANSPORT_MODE = "walking";

export const sortedItems = (schedule: TripSchedule): ScheduleItem[] =>
  [...schedule.items].sort((a, b) => a.day - b.day || a.order - b.order);

/** Pin labels for the map: visits numbered in trip order. */
export const visitLabels = (schedule: TripSchedule): Record<string, string> =>
  Object.fromEntries(sortedItems(schedule).map((item, index) => [item.placeId, String(index + 1)]));

function Summary({ schedule }: { schedule: TripSchedule }) {
  const { travelMin, spend, budget, covered, total } = schedule.totals;
  return (
    <dl className="summary" aria-label="Trip summary">
      <div>
        <dt className="eyebrow">Total travel</dt>
        <dd>{formatDuration(travelMin)}</dd>
      </div>
      <div>
        <dt className="eyebrow">Ticket spend</dt>
        <dd>
          {formatMoney(spend)} {budget === null ? "(no budget limit)" : `of ${formatMoney(budget)}`}
        </dd>
      </div>
      <div>
        <dt className="eyebrow">Places covered</dt>
        <dd>
          {covered} of {total}
        </dd>
      </div>
      <div>
        <dt className="eyebrow">Schedule quality</dt>
        <dd>{qualityText[schedule.quality]}</dd>
      </div>
    </dl>
  );
}

function SlackMarker({ slack, maxSlack }: { slack: number; maxSlack: number }) {
  if (slack === 0) {
    return (
      <Tooltip title="No slack: starting this visit late pushes back the rest of the day.">
        <Chip size="small" color="primary" label="tight" />
      </Tooltip>
    );
  }
  const text = `can start up to ${Math.round(slack)} min later`;
  return (
    <Tooltip title={text}>
      <div className="slack-track" data-testid="slack-track" role="img" aria-label={text}>
        <div
          className="slack-band"
          data-testid="slack-band"
          style={{ width: `${(slack / maxSlack) * 100}%` }}
        />
      </div>
    </Tooltip>
  );
}

function Visit({
  item,
  trip,
  maxSlack,
  last,
}: {
  item: ScheduleItem;
  trip: Trip;
  maxSlack: number;
  last: boolean;
}) {
  const selectedId = useTripStore((s) => s.selectedPlaceId);
  const setHovered = useTripStore((s) => s.setHovered);
  const setSelected = useTripStore((s) => s.setSelected);
  const selected = selectedId === item.placeId;
  const place = trip.places.find((candidate) => candidate.id === item.placeId);
  const panelId = `visit-${item.placeId}`;
  const ticket = formatScheduledTicket(item.ticket);
  const firstOfDay = item.order === 1;

  return (
    <TimelineItem
      data-testid="final-item"
      data-place-id={item.placeId}
      onMouseEnter={() => setHovered(item.placeId)}
      onMouseLeave={() => setHovered(null)}
      onFocus={() => setHovered(item.placeId)}
      onBlur={() => setHovered(null)}
    >
      <TimelineOppositeContent
        sx={{ pt: "1.7em", fontVariantNumeric: "tabular-nums", fontSize: "0.8rem" }}
      >
        {item.startLabel}–{item.endLabel}
      </TimelineOppositeContent>
      <TimelineSeparator>
        <TimelineConnector
          sx={{ minHeight: "1.5em", flexGrow: 0, visibility: firstOfDay ? "hidden" : "visible" }}
        />
        <TimelineDot color={item.slack === 0 ? "primary" : "grey"} sx={{ my: 0.5 }} />
        {!last && <TimelineConnector />}
      </TimelineSeparator>
      <TimelineContent sx={{ pb: 2, pr: 0, minWidth: 0 }}>
        <span className="travel-leg" data-testid="travel-leg">
          {item.travelFromPrevMin > 0
            ? `${formatDuration(item.travelFromPrevMin)} ${TRANSPORT_MODE}${firstOfDay ? " from your start point" : ""}`
            : ""}
        </span>
        <button
          type="button"
          className="visit-head"
          aria-expanded={selected}
          aria-controls={panelId}
          onClick={() => setSelected(selected ? null : item.placeId)}
        >
          <span className="visit-name">{item.name}</span>
          <Typography variant="body2" component="span" sx={{ display: "block" }}>
            {ticket}
          </Typography>
        </button>
        <Stack
          direction="row"
          spacing={0.5}
          useFlexGap
          sx={{ flexWrap: "wrap", alignItems: "center", mt: 0.5 }}
        >
          {place?.data?.needs_reservation === true && <ReservationBadge needed />}
          {item.shortened && <Chip size="small" variant="outlined" label="shortened visit" />}
        </Stack>
        {item.hoursAssumed && (
          <Tooltip title="No opening hours were found, so this time assumes normal daytime hours. Check before you go.">
            <Chip size="small" label="hours not confirmed" />
          </Tooltip>
        )}
        <SlackMarker slack={item.slack} maxSlack={maxSlack} />
        <Collapse in={selected} unmountOnExit>
          <div
            id={panelId}
            role="region"
            aria-label={`Details for ${item.name}`}
            style={{
              marginTop: 8,
              padding: 12,
              border: "1px solid var(--rule)",
              borderRadius: "var(--radius)",
              background: "var(--surface)",
            }}
          >
            <Typography variant="h4" component="h4" gutterBottom>
              Your ticket: {ticket}
            </Typography>
            <Typography variant="body2" gutterBottom>
              {formatDate(item.date)}, {item.startLabel}–{item.endLabel} ({formatDuration(item.dur)}
              )
            </Typography>
            {place ? (
              <PlaceDetails place={place} state={trip.state} />
            ) : (
              <p>No details are stored for this place.</p>
            )}
          </div>
        </Collapse>
      </TimelineContent>
    </TimelineItem>
  );
}

function DroppedRow({ place, trip }: { place: DroppedPlace; trip: Trip }) {
  const optimize = useTripStore((s) => s.optimize);
  const action = useAction();
  return (
    <li style={{ marginBottom: 12 }}>
      <strong>{place.name}</strong>: {dropReasonText[place.reason]}.{" "}
      <span className="plain-text">{place.detail}</span>{" "}
      <Button
        size="small"
        variant="outlined"
        disabled={action.pending}
        onClick={() =>
          void action.run(() =>
            optimize(trip.id, { forcePlaceIds: [place.placeId], allowShortening: true }),
          )
        }
      >
        {action.pending ? "Trying..." : "Try to fit this in"}
      </Button>
      {action.error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {action.error}
        </Alert>
      )}
    </li>
  );
}

export function FinalView({ trip }: { trip: Trip }) {
  const setView = useTripStore((s) => s.setView);
  const schedule = trip.optimization.result;
  const items = schedule ? sortedItems(schedule) : [];
  const maxSlack = Math.max(1, ...items.map((item) => item.slack));
  const settled = trip.optimization.status === "solved" || trip.optimization.status === "fallback";

  return (
    <section aria-label="Final schedule">
      <Stack
        direction="row"
        useFlexGap
        spacing={1}
        sx={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}
      >
        <Typography variant="h2">Your schedule</Typography>
        <Button size="small" onClick={() => setView("review")}>
          Back to review
        </Button>
      </Stack>

      {/* Stays visible here so a re-solve started from this view shows its progress and outcome. */}
      <OptimizationStatus trip={trip} showFinalize={false} />

      {schedule && (
        <>
          {!settled && (
            <Typography color="text.secondary" gutterBottom>
              Shown below: the most recent schedule.
            </Typography>
          )}
          <Summary schedule={schedule} />
          {items.length === 0 && <Typography>No visits could be scheduled.</Typography>}
          <Timeline
            data-testid="final-timeline"
            aria-label="Trip schedule"
            sx={{
              p: 0,
              m: 0,
              [`& .${timelineItemClasses.root}`]: { minHeight: 0 },
              [`& .${timelineOppositeContentClasses.root}`]: {
                flex: "0 0 112px",
                pl: 0,
                whiteSpace: "nowrap",
              },
            }}
          >
            {items.map((item, index) => {
              const next = items[index + 1];
              return (
                <Fragment key={item.placeId}>
                  {item.order === 1 || items[index - 1]?.day !== item.day ? (
                    <li className="final-day" data-testid="final-day">
                      <span className="eyebrow">Day {item.day}</span>{" "}
                      <Typography variant="h3" component="h3" sx={{ display: "inline" }}>
                        {formatDate(item.date)}
                      </Typography>
                    </li>
                  ) : null}
                  <Visit
                    item={item}
                    trip={trip}
                    maxSlack={maxSlack}
                    last={!next || next.day !== item.day}
                  />
                </Fragment>
              );
            })}
          </Timeline>

          {schedule.dropped.length > 0 && (
            <Accordion
              disableGutters
              variant="outlined"
              sx={{ mt: 2, background: "transparent" }}
              slotProps={{ transition: { unmountOnExit: true } }}
            >
              <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ fontFamily: "inherit" }}>
                Not included ({schedule.dropped.length})
              </AccordionSummary>
              <AccordionDetails>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {schedule.dropped.map((place) => (
                    <DroppedRow key={place.placeId} place={place} trip={trip} />
                  ))}
                </ul>
              </AccordionDetails>
            </Accordion>
          )}

          {import.meta.env.DEV && (
            <details className="dev-panel" data-testid="diagnostics" style={{ marginTop: 16 }}>
              <summary className="eyebrow">Diagnostics (dev only)</summary>
              <pre>{JSON.stringify(schedule.diagnostics, null, 2)}</pre>
            </details>
          )}
        </>
      )}
    </section>
  );
}
