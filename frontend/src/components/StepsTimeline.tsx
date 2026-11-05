import {
  Timeline,
  TimelineConnector,
  TimelineContent,
  TimelineDot,
  TimelineItem,
  TimelineSeparator,
  timelineItemClasses,
} from "@mui/lab";
import { Tooltip } from "@mui/material";
import type { Trip, TripStep } from "@triplanner/shared";
import { canViewStep, resolveView, stepState, type StepState } from "../lib/steps";
import { useTripStore } from "../store";

const STEPS: { step: TripStep; number: number; label: string; help: string }[] = [
  {
    step: "intake",
    number: 0,
    label: "Trip intake",
    help: "Chat about where and when you travel, what you want to do, and your budget.",
  },
  {
    step: "refinement",
    number: 1,
    label: "Place refinement",
    help: "If your plans were open-ended, pick from the places found on the web. Skipped when you named every place.",
  },
  {
    step: "place_data",
    number: 2,
    label: "Place data",
    help: "Bots look up hours, tickets and details for each place, for your dates only. Up to a minute per place.",
  },
  {
    step: "review",
    number: 3,
    label: "Review and schedule",
    help: "Check the gathered data and the map. The schedule optimization (step 4) runs at the same time.",
  },
  {
    step: "final",
    number: 5,
    label: "Final view",
    help: "Your day-by-day schedule, with tickets, travel times and how much slack each visit has.",
  },
];

const DOT_COLOR: Record<StepState, "primary" | "grey"> = {
  complete: "grey",
  current: "primary",
  upcoming: "grey",
  skipped: "grey",
};

const STATE_TEXT: Record<StepState, string> = {
  complete: "complete",
  current: "current",
  upcoming: "upcoming",
  skipped: "skipped",
};

export function StepsTimeline({ trip }: { trip: Trip }) {
  const viewOverride = useTripStore((s) => s.viewOverride);
  const setView = useTripStore((s) => s.setView);
  const view = resolveView(trip, viewOverride);
  const placesDone = trip.places.filter((place) => place.status === "done").length;

  return (
    <Timeline
      data-testid="steps-timeline"
      aria-label="Trip planning steps"
      className="steps"
      sx={{
        flex: "none",
        p: 0,
        m: 0,
        [`& .${timelineItemClasses.root}::before`]: { flex: 0, padding: 0 },
        [`& .${timelineItemClasses.root}`]: { minHeight: 56 },
      }}
    >
      {STEPS.map(({ step, number, label, help }, index) => {
        const state = stepState(trip, step);
        const viewing = view === step || (step === "review" && view === "place_data");
        const canOpen = canViewStep(trip, step) && !viewing && state !== "skipped";
        return (
          <TimelineItem
            key={step}
            data-step={step}
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
          >
            <TimelineSeparator>
              <TimelineDot
                color={DOT_COLOR[state]}
                variant={state === "skipped" || state === "upcoming" ? "outlined" : "filled"}
              />
              {index < STEPS.length - 1 && <TimelineConnector />}
            </TimelineSeparator>
            <TimelineContent sx={{ py: 0.5, pr: 0 }}>
              <Tooltip title={help} placement="left" arrow describeChild>
                <div tabIndex={0}>
                  <span className="eyebrow">Step {number} </span>
                  {canOpen ? (
                    <button
                      type="button"
                      className="step-button step-label"
                      onClick={() => setView(step === trip.step ? null : step)}
                    >
                      {label}
                    </button>
                  ) : (
                    <span className="step-label">{label}</span>
                  )}
                  <div className="eyebrow">
                    {STATE_TEXT[state]}
                    {step === "place_data" && trip.places.length > 0
                      ? ` · ${placesDone} of ${trip.places.length} ready`
                      : ""}
                  </div>
                  {step === "review" && (
                    <div className="eyebrow" data-testid="timeline-optimization">
                      Step 4, schedule optimization: {trip.optimization.status}
                    </div>
                  )}
                </div>
              </Tooltip>
            </TimelineContent>
          </TimelineItem>
        );
      })}
    </Timeline>
  );
}
