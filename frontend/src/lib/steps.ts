import type { Trip, TripStep } from "@triplanner/shared";
import { TRIP_STEPS } from "@triplanner/shared";

export type StepState = "complete" | "current" | "upcoming" | "skipped";

export const stepIndex = (step: TripStep): number => TRIP_STEPS.indexOf(step);

/** True when step 1 was passed without any search having been needed or run. */
export const refinementSkipped = (trip: Trip): boolean =>
  stepIndex(trip.step) > stepIndex("refinement") &&
  !trip.state.needs_search &&
  trip.proposals.status === "idle" &&
  trip.proposals.items.length === 0;

export const stepState = (trip: Trip, step: TripStep): StepState => {
  if (step === "refinement" && refinementSkipped(trip)) return "skipped";
  const position = stepIndex(step);
  const current = stepIndex(trip.step);
  if (position === current) return "current";
  return position < current ? "complete" : "upcoming";
};

/** Steps with a view worth returning to. A confirmed proposal list cannot be re-confirmed. */
export const canViewStep = (trip: Trip, step: TripStep): boolean => {
  if (stepIndex(step) > stepIndex(trip.step)) return false;
  return step !== "refinement" || trip.step === "refinement";
};

/** The screen to show: the trip's own step, unless the user went back to an earlier one. */
export const resolveView = (trip: Trip, override: TripStep | null): TripStep =>
  override && canViewStep(trip, override) ? override : trip.step;
