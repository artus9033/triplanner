import { z } from "zod";

/**
 * HTTP contract. Every mutating trip route returns the full updated Trip.
 *
 *   GET    /api/health                           Health
 *   POST   /api/auth              {password}     204, sets the gate cookie
 *   GET    /api/trips                            TripSummary[]
 *   POST   /api/trips                            Trip
 *   GET    /api/trips/:id                        Trip
 *   DELETE /api/trips/:id                        204
 *   GET    /api/trips/:id/events                 SSE stream of TripEvent
 *   POST   /api/trips/:id/messages {content}     Trip   step 0 chat
 *   POST   /api/trips/:id/proposals/retry        Trip   step 1 search again
 *   POST   /api/trips/:id/proposals/confirm {placeIds}   Trip   step 1 selection
 *   POST   /api/trips/:id/places/:placeId/retry  Trip   step 2 retry one failed place
 *   POST   /api/trips/:id/optimize  OptimizeRequest      Trip   re-solve with changes
 *   POST   /api/trips/:id/finalize               Trip   go to the final view
 *   GET    /api/speech/status                    SpeechStatus
 *   POST   /api/speech/transcribe  raw audio body (audio/wav)   {text}
 *   POST   /api/speech/tts  {text}               audio/wav
 *
 * Errors: non-2xx with ApiError, whose message is shown on screen.
 */

export const ApiErrorSchema = z.object({ error: z.string() });
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const FeatureLevelSchema = z.enum(["ready", "degraded", "missing"]);
export type FeatureLevel = z.infer<typeof FeatureLevelSchema>;
export const FeatureHealthSchema = z.object({ status: FeatureLevelSchema, detail: z.string() });
export type FeatureHealth = z.infer<typeof FeatureHealthSchema>;

export const HealthSchema = z.object({
  ok: z.boolean(),
  db: FeatureHealthSchema,
  ampl: FeatureHealthSchema,
  speech: FeatureHealthSchema,
  llm: FeatureHealthSchema,
});
export type Health = z.infer<typeof HealthSchema>;

export const VoiceFeatureSchema = z.object({
  /** ready: usable. downloading: fetching lazily. unavailable: see reason. */
  status: z.enum(["ready", "downloading", "unavailable"]),
  reason: z.string().nullable(),
});
export const SpeechStatusSchema = z.object({ stt: VoiceFeatureSchema, tts: VoiceFeatureSchema });
export type SpeechStatus = z.infer<typeof SpeechStatusSchema>;

/** Options from the "infeasible" and "dropped places" UI (02 §4.7, §4.9). */
export const OptimizeRequestSchema = z.object({
  /** Allow shortening visits ("fit more in"). */
  allowShortening: z.boolean().optional(),
  /** Treat these places as mandatory ("try to fit this in"). */
  forcePlaceIds: z.array(z.string()).optional(),
  /** Remove these places from the trip. */
  dropPlaceIds: z.array(z.string()).optional(),
  /** Widen the daily envelope, "HH:MM". */
  dayWindow: z.object({ start: z.string(), end: z.string() }).optional(),
  /** Extend the trip dates. */
  endDate: z.string().optional(),
});
export type OptimizeRequest = z.infer<typeof OptimizeRequestSchema>;

export const TripEventSchema = z.object({ type: z.literal("trip.updated"), tripId: z.string() });
export type TripEvent = z.infer<typeof TripEventSchema>;
