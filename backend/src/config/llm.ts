/** Tuning values for all Apex calls, made through the Vercel AI SDK. */
export const APEX_BASE_URL = "https://api.callstack.ai/v1";
export const APEX_MODEL = "callstack/Apex";
/** Apex accepts none, low, medium and xhigh. */
export const INTAKE_EFFORT = "low";
export const SEARCH_EFFORT = "medium";
/** Page fetches allowed per step 1 request. Apex has no web search, so suggestions lean on these. */
export const PROPOSAL_FETCH_MAX_USES = 4;
/** Page fetches allowed per place in step 2. */
export const PLACE_FETCH_MAX_USES = 5;
/** Hard limit on one step 1 request. */
export const PROPOSAL_TIME_BUDGET_MS = 120_000;
export const RESEARCH_MAX_TOKENS = 8000;
export const EXTRACT_MAX_TOKENS = 8000;
export const INTAKE_MAX_TOKENS = 2000;

/** Limits on the fetch_page tool. */
export const PAGE_FETCH_TIMEOUT_MS = 10_000;
export const PAGE_MAX_BYTES = 2_000_000;
export const PAGE_MAX_CHARS = 12_000;
export const PAGE_MAX_LINKS = 40;
export const PAGE_MAX_REDIRECTS = 4;
export const PAGE_USER_AGENT = "Triplanner/0.1 (trip planning app)";

/** Nominatim's usage policy allows at most one request per second. */
export const GEOCODE_URL = "https://nominatim.openstreetmap.org/search";
export const GEOCODE_INTERVAL_MS = 1100;
