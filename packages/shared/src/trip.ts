import { z } from "zod";
import { PlaceCategorySchema, PlaceDataSchema, SourceSchema } from "./place";
import { OptimizationSchema } from "./optimizer";

/** Steps as shown on the timeline: 0, 1, 2, 3 (houses the optimization, step 4), 5. */
export const TRIP_STEPS = ["intake", "refinement", "place_data", "review", "final"] as const;
export const TripStepSchema = z.enum(TRIP_STEPS);
export type TripStep = z.infer<typeof TripStepSchema>;

export const NamedPlaceSchema = z.object({
  name: z.string(),
  note: z.string().nullable().describe("Details the user gave, e.g. 'Richelieu wing'"),
});
export type NamedPlace = z.infer<typeof NamedPlaceSchema>;

/** Filled in by the step 0 state machine. */
export const TripStateSchema = z.object({
  city: z.string().nullable(),
  start_date: z.string().nullable().describe("YYYY-MM-DD"),
  end_date: z.string().nullable().describe("YYYY-MM-DD"),
  plans: z.string().nullable().describe("What the user wants to do, in their words"),
  /** Specific places the user named. These become mandatory. */
  named_places: z.array(NamedPlaceSchema),
  /** True when any wish is unspecific ("modern art galleries"), so step 1 has to search. */
  needs_search: z.boolean(),
  /** True once the user has answered the budget question, including "no limit". */
  budget_answered: z.boolean(),
  /** null means no limit, once budget_answered is true. */
  budget_usd: z.number().nonnegative().nullable(),
});
export type TripState = z.infer<typeof TripStateSchema>;

export const emptyTripState = (): TripState => ({
  city: null,
  start_date: null,
  end_date: null,
  plans: null,
  named_places: [],
  needs_search: false,
  budget_answered: false,
  budget_usd: null,
});

export const ChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** A place proposed in step 1, shown as one multiselect option with one link. */
export const PlaceProposalSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: PlaceCategorySchema,
  why: z.string(),
  link: z.string().nullable(),
  link_kind: z.enum(["google_maps", "website"]).nullable(),
  sources: z.array(SourceSchema),
});
export type PlaceProposal = z.infer<typeof PlaceProposalSchema>;

export const ProposalsSchema = z.object({
  status: z.enum(["idle", "running", "ready", "failed"]),
  items: z.array(PlaceProposalSchema),
  error: z.string().nullable(),
});
export type Proposals = z.infer<typeof ProposalsSchema>;

/** One place to visit, carrying its step 2 bot result. Exists from step 1's confirmation on. */
export const TripPlaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  note: z.string().nullable(),
  /** True for places the user named (P^must); false for picked suggestions (P^opt). */
  must: z.boolean(),
  /** Position in the user's selection, starting at 1. Drives the utility of optional places. */
  rank: z.number().int().positive(),
  status: z.enum(["queued", "running", "done", "failed"]),
  /** Visible failure text. */
  error: z.string().nullable(),
  data: PlaceDataSchema.nullable(),
  /** Attached by the backend from citations, never by the model. */
  sources: z.array(SourceSchema),
  /** Which model answered the research call, after any server-side fallback. */
  model: z.string().nullable(),
  durationMs: z.number().nullable(),
});
export type TripPlace = z.infer<typeof TripPlaceSchema>;

/** Re-solve choices the user made, kept on the trip so later solves honour them. */
export const SolverOptionsSchema = z.object({
  allowShortening: z.boolean().optional(),
  dayWindow: z.object({ start: z.string(), end: z.string() }).optional(),
});
export type SolverOptions = z.infer<typeof SolverOptionsSchema>;

export const TripSchema = z.object({
  id: z.string(),
  title: z.string(),
  step: TripStepSchema,
  state: TripStateSchema,
  messages: z.array(ChatMessageSchema),
  proposals: ProposalsSchema,
  places: z.array(TripPlaceSchema),
  optimization: OptimizationSchema,
  solverOptions: SolverOptionsSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Trip = z.infer<typeof TripSchema>;

export const TripSummarySchema = TripSchema.pick({
  id: true,
  title: true,
  step: true,
  updatedAt: true,
});
export type TripSummary = z.infer<typeof TripSummarySchema>;
