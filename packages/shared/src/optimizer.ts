import { z } from "zod";

/** Hours assumed for a place when none could be found. The daily window still applies on top. */
export const ASSUMED_OPEN_HOURS = { start: "08:00", end: "22:00" };

export const OPTIMIZATION_STATUSES = [
  "pending",
  "running",
  "solved",
  "infeasible",
  "fallback",
  "failed",
] as const;
export const OptimizationStatusSchema = z.enum(OPTIMIZATION_STATUSES);
export type OptimizationStatus = z.infer<typeof OptimizationStatusSchema>;

/** "unknown" stands in when no usable ticket data was scraped: the price is treated as 0. */
export const TicketKindSchema = z.enum(["free", "paid", "reduced", "unknown"]);
export type TicketKind = z.infer<typeof TicketKindSchema>;

export const InstanceDaySchema = z.object({
  /** 1-based index d. Day d starts at absolute minute 1440 * (d - 1). */
  day: z.number().int().positive(),
  date: z.string(),
  dayStart: z.number(),
  dayEnd: z.number(),
  nMax: z.number().int().positive(),
});
export type InstanceDay = z.infer<typeof InstanceDaySchema>;

export const InstancePlaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  must: z.boolean(),
  /** Utility u_p. */
  u: z.number().positive(),
  dur: z.number().positive(),
  durMin: z.number().nonnegative(),
  delta: z.number().nonnegative(),
  /** No hours were found, so the windows come from ASSUMED_OPEN_HOURS. */
  hoursAssumed: z.boolean().optional(),
  /** Only available days appear: absolute minutes, already clamped to the day envelope. */
  windows: z.array(z.object({ day: z.number().int(), open: z.number(), close: z.number() })),
  /** One entry per ticket kind, cheapest variant of that kind, normalized into budget currency. */
  tickets: z.array(
    z.object({
      kind: TicketKindSchema,
      price: z.number().nonnegative(),
      label: z.string().nullable(),
      eligibleDays: z.array(z.number().int()),
    }),
  ),
});
export type InstancePlace = z.infer<typeof InstancePlaceSchema>;

export const TripInstanceSchema = z.object({
  days: z.array(InstanceDaySchema),
  places: z.array(InstancePlaceSchema),
  /** tau[from][to] in minutes. Node ids are place ids plus "START" and "END". */
  tau: z.record(z.string(), z.record(z.string(), z.number().nonnegative())),
  budget: z.number().nonnegative().nullable(),
  /** Shortening budget (02 §4.6). */
  Q: z.number().int().nonnegative(),
  lamTau: z.number().nonnegative(),
  lamCost: z.number().nonnegative(),
  lamL1: z.number().nonnegative(),
  mode: z.enum(["walking", "transit", "driving"]),
});
export type TripInstance = z.infer<typeof TripInstanceSchema>;

export const DropReasonSchema = z.enum([
  "no_hours_data",
  "closed_on_trip_dates",
  "outside_daily_envelope",
  "ticket_over_budget",
  "unreachable_within_day",
  "lower_priority",
]);
export type DropReason = z.infer<typeof DropReasonSchema>;

export const ScheduleItemSchema = z.object({
  placeId: z.string(),
  name: z.string(),
  day: z.number().int(),
  date: z.string(),
  /** Position within the day, starting at 1. */
  order: z.number().int(),
  /** Absolute minutes on the trip axis. */
  start: z.number(),
  end: z.number(),
  /** Local clock labels, "HH:MM". */
  startLabel: z.string(),
  endLabel: z.string(),
  dur: z.number(),
  shortened: z.boolean(),
  /** The visit's time rests on assumed hours rather than hours found on a page. */
  hoursAssumed: z.boolean().optional(),
  /** s_late - s_early. Zero means a "tight" visit. */
  slack: z.number().nonnegative(),
  travelFromPrevMin: z.number().nonnegative(),
  ticket: z.object({
    kind: TicketKindSchema,
    price: z.number().nonnegative(),
    label: z.string().nullable(),
  }),
});
export type ScheduleItem = z.infer<typeof ScheduleItemSchema>;

export const DroppedPlaceSchema = z.object({
  placeId: z.string(),
  name: z.string(),
  must: z.boolean(),
  reason: DropReasonSchema,
  detail: z.string(),
});
export type DroppedPlace = z.infer<typeof DroppedPlaceSchema>;

export const DiagnosticsSchema = z.object({
  solver: z.string().nullable(),
  wallMs: z.number(),
  instanceHash: z.string(),
  passes: z.array(
    z.object({
      name: z.string(),
      objective: z.number().nullable(),
      status: z.string(),
      gap: z.number().nullable(),
      wallMs: z.number().nullable(),
    }),
  ),
  warnings: z.array(z.string()),
  /** Why the heuristic ran instead of AMPL, when it did. */
  fallbackReason: z.string().nullable(),
});
export type Diagnostics = z.infer<typeof DiagnosticsSchema>;

export const TripScheduleSchema = z.object({
  /** optimal: proven by the solver. good: best incumbent at the time limit. heuristic: fallback. */
  quality: z.enum(["optimal", "good", "heuristic"]),
  items: z.array(ScheduleItemSchema),
  dayEnds: z.array(
    z.object({ day: z.number().int(), finish: z.number(), returnTravelMin: z.number() }),
  ),
  dropped: z.array(DroppedPlaceSchema),
  totals: z.object({
    travelMin: z.number(),
    spend: z.number(),
    budget: z.number().nullable(),
    covered: z.number().int(),
    total: z.number().int(),
  }),
  diagnostics: DiagnosticsSchema,
});
export type TripSchedule = z.infer<typeof TripScheduleSchema>;

export const OptimizationSchema = z.object({
  status: OptimizationStatusSchema,
  startedAt: z.string().nullable(),
  instanceHash: z.string().nullable(),
  /** A usable schedule for solved and fallback; a partial one (with dropped musts) for infeasible. */
  result: TripScheduleSchema.nullable(),
  /** Visible failure text for the failed status. */
  error: z.string().nullable(),
});
export type Optimization = z.infer<typeof OptimizationSchema>;
