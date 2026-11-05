/** Tuning values for all Claude API calls (plan 04, "LLM: Claude API"). */
export const CLAUDE_MODEL = "claude-opus-5-5";
export const INTAKE_EFFORT = "low";
export const SEARCH_EFFORT = "medium";
export const PROPOSAL_SEARCH_MAX_USES = 10;
export const PLACE_SEARCH_MAX_USES = 5;
/** Cap on pause_turn continuations of one research call. */
export const MAX_PAUSE_CONTINUATIONS = 3;
/** Hard limit on one step 1 search. Up to 10 searches, so this is longer than a place bot gets. */
export const PROPOSAL_TIME_BUDGET_MS = 180_000;
export const RESEARCH_MAX_TOKENS = 8000;
export const EXTRACT_MAX_TOKENS = 8000;
/** Beta that re-runs a declined research request on another model. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
