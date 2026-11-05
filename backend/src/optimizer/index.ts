import type {
  Diagnostics,
  DroppedPlace,
  OptimizationStatus,
  TripInstance,
  TripPlace,
  TripSchedule,
  TripState,
} from "@triplanner/shared";
import { OPTIMIZER_TIME_LIMIT_MS, SOLVER } from "../config/optimizer";
import { buildInstance, InstanceError } from "./buildInstance";
import { runFallback } from "./fallback";
import { parsePasses, parseSolution, passProvedOptimal } from "./parseSolution";
import { checkAmpl, resolveAmpl, runSolver } from "./runSolver";
import { assembleSchedule, type DayPlans } from "./schedule";
import { validateSchedule } from "./validate";
import { hashInstance, writeData } from "./writeData";

export interface OptimizeOptions {
  /** Q = SHORTEN_BUDGET_ALLOWED instead of SHORTEN_BUDGET. */
  allowShortening?: boolean;
  /** Treated as must. */
  forcePlaceIds?: string[];
  /** Overrides DAY_WINDOW. */
  dayWindow?: { start: string; end: string };
  /** Default OPTIMIZER_TIME_LIMIT_MS. */
  timeLimitMs?: number;
  /** Test hook. null forces the fallback. */
  amplBin?: string | null;
}

export interface OptimizeOutcome {
  status: OptimizationStatus;
  instanceHash: string;
  result: TripSchedule | null;
  error: string | null;
}

const CACHE_MAX_ENTRIES = 200;
const cache = new Map<string, OptimizeOutcome>();

export const clearOptimizerCache = (): void => cache.clear();

const remember = (outcome: OptimizeOutcome): void => {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(outcome.instanceHash, structuredClone(outcome));
};

const statusOf = (schedule: TripSchedule): OptimizationStatus =>
  schedule.dropped.some((place) => place.must) ? "infeasible" : "solved";

interface EngineContext {
  instance: TripInstance;
  instanceHash: string;
  presolveDropped: DroppedPlace[];
  warnings: string[];
  total: number;
  started: number;
}

const diagnosticsFor = (
  context: EngineContext,
  fields: Pick<Diagnostics, "solver" | "passes" | "fallbackReason">,
): Diagnostics => ({
  ...fields,
  wallMs: Date.now() - context.started,
  instanceHash: context.instanceHash,
  warnings: context.warnings,
});

/** §4.8. The result is still checked: an invalid heuristic schedule must not reach the user. */
const fallbackOutcome = (context: EngineContext, reason: string): OptimizeOutcome => {
  const { instance, instanceHash } = context;
  try {
    const schedule = assembleSchedule({
      instance,
      plans: runFallback(instance),
      presolveDropped: context.presolveDropped,
      total: context.total,
      quality: "heuristic",
      diagnostics: diagnosticsFor(context, { solver: null, passes: [], fallbackReason: reason }),
    });
    const errors = validateSchedule(instance, schedule);
    if (errors.length > 0) throw new Error(errors.join("; "));
    // A must with no possible day is proven by presolve, whichever engine ran. An unplaced must that
    // only the heuristic failed on proves nothing, so that one stays "fallback".
    const provenInfeasible = context.presolveDropped.some((place) => place.must);
    return {
      status: provenInfeasible ? "infeasible" : "fallback",
      instanceHash,
      result: schedule,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      instanceHash,
      result: null,
      error: `The solver failed (${reason}) and so did the fallback: ${message}`,
    };
  }
};

const solverOutcome = async (
  context: EngineContext,
  dat: string,
  symbols: Map<string, string>,
  amplBin: string,
  timeLimitMs: number,
): Promise<OptimizeOutcome> => {
  const { instance, instanceHash } = context;
  const run = await runSolver(dat, amplBin, timeLimitMs);
  const parsed = parseSolution(run.solutionCsv, symbols);
  if (!parsed) {
    return fallbackOutcome(
      context,
      run.failure ?? "AMPL finished without writing a usable solution.",
    );
  }

  const passes = parsePasses(run.passesCsv);
  const required = passes.filter((pass) => pass.name !== "slack");
  const reachedCompactness = passes.some((pass) => pass.name === "compactness");
  const proved =
    !run.timedOut &&
    reachedCompactness &&
    required.filter(isSolvedOrInfeasible).length === required.length;

  try {
    const schedule = assembleSchedule({
      instance,
      plans: parsed.plans,
      lateStarts: parsed.lateStarts,
      presolveDropped: context.presolveDropped,
      total: context.total,
      quality: proved ? "optimal" : "good",
      diagnostics: diagnosticsFor(context, {
        solver: `ampl/${SOLVER}`,
        passes,
        fallbackReason: null,
      }),
    });
    const errors = validateSchedule(instance, schedule);
    if (errors.length > 0) throw new Error(errors.slice(0, 3).join("; "));
    return { status: statusOf(schedule), instanceHash, result: schedule, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fallbackOutcome(context, `The solver's solution failed validation: ${message}`);
  }
};

/** Pass 1 being infeasible is a finding, not a failure: the elastic pass answers it. */
const isSolvedOrInfeasible = (pass: Diagnostics["passes"][number]): boolean =>
  passProvedOptimal(pass) || (pass.name === "coverage" && pass.status.startsWith("infeasible"));

export interface InstanceSolveOptions {
  presolveDropped?: DroppedPlace[];
  warnings?: string[];
  total?: number;
  timeLimitMs?: number;
  amplBin?: string | null;
  /** Mixed into the hash: what the outcome depends on that trip.dat leaves out. */
  hashContext?: unknown;
}

/** Solves a built instance. optimizeTrip's core, and the entry point for hand-made fixtures. */
export const optimizeInstance = async (
  instance: TripInstance,
  options: InstanceSolveOptions = {},
): Promise<OptimizeOutcome> => {
  const started = Date.now();
  const { dat, symbols } = writeData(instance);
  const presolveDropped = options.presolveDropped ?? [];
  const warnings = options.warnings ?? [];
  const instanceHash = hashInstance(dat, {
    places: instance.places.map((place) => ({
      id: place.id,
      name: place.name,
      labels: place.tickets.map((ticket) => ticket.label),
    })),
    dates: instance.days.map((day) => day.date),
    mode: instance.mode,
    presolveDropped,
    warnings,
    context: options.hashContext ?? null,
  });

  const cached = cache.get(instanceHash);
  if (cached) return structuredClone(cached);

  const context: EngineContext = {
    instance,
    instanceHash,
    presolveDropped,
    warnings,
    total: options.total ?? instance.places.length + presolveDropped.length,
    started,
  };

  if (instance.places.length === 0) {
    const schedule = assembleSchedule({
      instance,
      plans: new Map() as DayPlans,
      presolveDropped,
      total: context.total,
      quality: "optimal",
      diagnostics: diagnosticsFor(context, { solver: null, passes: [], fallbackReason: null }),
    });
    return { status: statusOf(schedule), instanceHash, result: schedule, error: null };
  }

  const amplBin = options.amplBin === undefined ? resolveAmpl() : options.amplBin;
  if (amplBin === null) {
    return fallbackOutcome(
      context,
      options.amplBin === null ? "AMPL is disabled for this run." : "AMPL was not found.",
    );
  }

  const outcome = await solverOutcome(
    context,
    dat,
    symbols,
    amplBin,
    options.timeLimitMs ?? OPTIMIZER_TIME_LIMIT_MS,
  );
  // Only proven results are cached: AMPL may be back, or have more time, on the next run.
  if (outcome.result?.quality === "optimal") remember(outcome);
  return outcome;
};

const restoreIds = (
  outcome: OptimizeOutcome,
  originalIds: Map<string, string>,
): OptimizeOutcome => {
  if (originalIds.size === 0 || !outcome.result) return outcome;
  const original = (id: string): string => originalIds.get(id) ?? id;
  return {
    ...outcome,
    result: {
      ...outcome.result,
      items: outcome.result.items.map((item) => ({ ...item, placeId: original(item.placeId) })),
      dropped: outcome.result.dropped.map((place) => ({
        ...place,
        placeId: original(place.placeId),
      })),
    },
  };
};

/** Trip to schedule. Degrades to the fallback rather than failing; never rejects for solver faults. */
export const optimizeTrip = async (
  input: { state: TripState; places: TripPlace[] },
  options: OptimizeOptions = {},
): Promise<OptimizeOutcome> => {
  let built: ReturnType<typeof buildInstance>;
  try {
    built = buildInstance(input, options);
  } catch (error) {
    if (!(error instanceof InstanceError)) throw error;
    return { status: "failed", instanceHash: "", result: null, error: error.message };
  }
  const outcome = await optimizeInstance(built.instance, {
    presolveDropped: built.presolveDropped,
    warnings: built.warnings,
    total: built.total,
    timeLimitMs: options.timeLimitMs,
    amplBin: options.amplBin,
  });
  return restoreIds(outcome, built.originalIds);
};

/** For /api/health. */
export const amplStatus = (): Promise<{ available: boolean; detail: string }> => checkAmpl();

export { validateSchedule } from "./validate";
