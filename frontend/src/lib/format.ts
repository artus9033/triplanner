import { ASSUMED_OPEN_HOURS } from "@triplanner/shared";
import type {
  DropReason,
  PlaceData,
  ScheduleItem,
  Ticket,
  TripSchedule,
  TripState,
} from "@triplanner/shared";

const parseDay = (iso: string): Date | null => {
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** "2026-05-12" to "Tue 12 May 2026". Dates are calendar days, so this never shifts by time zone. */
export const formatDate = (iso: string): string => {
  const date = parseDay(iso);
  if (!date) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })
    .format(date)
    .replace(",", "");
};

export const addDays = (iso: string, days: number): string => {
  const date = parseDay(iso);
  if (!date) return iso;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

export const formatDuration = (minutes: number): string => {
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min`;
  const rest = rounded % 60;
  return rest === 0 ? `${Math.floor(rounded / 60)} h` : `${Math.floor(rounded / 60)} h ${rest} min`;
};

export const formatMoney = (amount: number): string =>
  `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;

export const formatScheduledTicket = (ticket: ScheduleItem["ticket"]): string => {
  const label = ticket.label ? ` (${ticket.label})` : "";
  if (ticket.kind === "free") return `Free${label}`;
  if (ticket.kind === "unknown") return "Ticket price unknown";
  return `${formatMoney(ticket.price)}, ${ticket.kind}${label}`;
};

export const formatTicket = (ticket: Ticket): string =>
  [ticket.type, ticket.price, ticket.condition].filter(Boolean).join(" · ");

/** Hours within the trip's dates. Without known dates, all the hours the bot found. */
export const hoursForTrip = (data: PlaceData, state: TripState): PlaceData["hours"] =>
  data.hours.filter(
    (h) =>
      (!state.start_date || h.date >= state.start_date) &&
      (!state.end_date || h.date <= state.end_date),
  );

/** What to say when a place shows no hours for the trip's dates. */
export const hoursNote = (data: PlaceData): string => {
  if (data.closed_during_trip) return "Closed on your dates";
  if (data.hours.length > 0) return "None found for your dates";
  return `Not found. The schedule assumes ${ASSUMED_OPEN_HOURS.start}–${ASSUMED_OPEN_HOURS.end}, so check before you go.`;
};

export const dropReasonText: Record<DropReason, string> = {
  no_hours_data: "No opening hours found",
  closed_on_trip_dates: "Closed on your dates",
  outside_daily_envelope: "Open only outside your daily hours",
  ticket_over_budget: "Ticket is over budget",
  unreachable_within_day: "Cannot be reached within the day",
  lower_priority: "Lower priority; did not fit",
};

export const qualityText: Record<TripSchedule["quality"], string> = {
  optimal: "optimal",
  good: "good schedule",
  heuristic: "heuristic",
};
