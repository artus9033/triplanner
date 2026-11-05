/** Optimizer constants (design 02 §4.10). */
export const MAX_BOTS = 5;
/** Hard budget across the research and extract calls of one place. */
export const BOT_TIME_BUDGET_MS = 60_000;
export const DAY_WINDOW = { start: "09:00", end: "20:00" };
export const MAX_VISITS_PER_DAY = 4;
export const DEFAULT_DURATIONS: Record<string, number> = {
  museum: 120,
  gallery: 60,
  restaurant: 90,
  viewpoint: 30,
  other: 60,
};
export const TRANSPORT_MODE = "walking" as const;
/** km/h, haversine fallback for travel times. */
export const MODE_SPEEDS = { walking: 4.5, transit: 18, driving: 30 };
/** Used for travel to or from a place with no coordinates; reported as a warning. */
export const UNKNOWN_TRAVEL_MIN = 30;
export const LAMBDA_TRAVEL = 1;
export const LAMBDA_L1 = 0.001;
export const SHORTEN_BUDGET = 0;
/** Q when the user asks to "fit more in". */
export const SHORTEN_BUDGET_ALLOWED = 3;
/** delta_p as a fraction of dur_p. */
export const SHORTEN_FRACTION = 0.25;
export const OPTIMIZER_TIME_LIMIT_MS = 10_000;
export const SOLVER = "highs" as const;
export const FALLBACK_MAX_PASSES = 2;
export const MUST_UTILITY = 100;
export const OPTIONAL_UTILITY = 10;
/** Static rates for normalizing ticket prices into USD. There is no live FX source. */
export const FX_TO_USD: Record<string, number> = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  CHF: 1.12,
  PLN: 0.25,
  JPY: 0.0067,
  CZK: 0.043,
  SEK: 0.095,
  NOK: 0.093,
  DKK: 0.145,
  CAD: 0.73,
  AUD: 0.65,
};
