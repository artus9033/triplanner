import { Alert, Button, LinearProgress, Stack, TextField, Typography } from "@mui/material";
import type { OptimizeRequest, Trip } from "@triplanner/shared";
import { useState } from "react";
import { addDays, dropReasonText } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useTripStore } from "../store";

function InfeasibleOptions({
  trip,
  disabled,
  onOptimize,
}: {
  trip: Trip;
  disabled: boolean;
  onOptimize: (request: OptimizeRequest) => void;
}) {
  const dropped = trip.optimization.result?.dropped ?? [];
  // Start from what the last solve already used, so "widen" really offers something wider.
  const lastWindow = trip.solverOptions?.dayWindow;
  const [dayStart, setDayStart] = useState(lastWindow?.start ?? "08:00");
  const [dayEnd, setDayEnd] = useState(lastWindow?.end ?? "22:00");
  const [endDate, setEndDate] = useState(
    trip.state.end_date ? addDays(trip.state.end_date, 1) : "",
  );

  return (
    <>
      {dropped.length > 0 ? (
        <>
          <Typography variant="h4" component="h4" sx={{ mt: 1 }}>
            What does not fit
          </Typography>
          <ul style={{ paddingLeft: 18, margin: "4px 0" }}>
            {dropped.map((place) => (
              <li key={place.placeId}>
                <strong>{place.name}</strong>: {dropReasonText[place.reason]}.{" "}
                <span className="plain-text">{place.detail}</span>{" "}
                <Button
                  size="small"
                  disabled={disabled}
                  onClick={() => onOptimize({ dropPlaceIds: [place.placeId] })}
                >
                  Drop {place.name}
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <Typography>The optimizer did not report which places conflict.</Typography>
      )}
      <Typography variant="h4" component="h4" sx={{ mt: 1, mb: 1 }}>
        Options
      </Typography>
      <Stack spacing={1.5} sx={{ alignItems: "flex-start" }}>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ flexWrap: "wrap", alignItems: "center" }}
        >
          <TextField
            label="Day starts"
            type="time"
            size="small"
            value={dayStart}
            onChange={(event) => setDayStart(event.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <TextField
            label="Day ends"
            type="time"
            size="small"
            value={dayEnd}
            onChange={(event) => setDayEnd(event.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <Button
            variant="outlined"
            disabled={disabled || !dayStart || !dayEnd}
            onClick={() => onOptimize({ dayWindow: { start: dayStart, end: dayEnd } })}
          >
            Widen the day
          </Button>
        </Stack>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ flexWrap: "wrap", alignItems: "center" }}
        >
          <TextField
            label="New last day"
            type="date"
            size="small"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <Button
            variant="outlined"
            disabled={disabled || !endDate}
            onClick={() => onOptimize({ endDate })}
          >
            Extend the dates
          </Button>
        </Stack>
        {trip.solverOptions?.allowShortening ? (
          <Typography color="text.secondary">Shorter visits are already allowed.</Typography>
        ) : (
          <Button
            variant="outlined"
            disabled={disabled}
            onClick={() => onOptimize({ allowShortening: true })}
          >
            Allow shorter visits
          </Button>
        )}
      </Stack>
    </>
  );
}

/** Step 4. Spells out the literal status word, which is what the operating bot reads. */
export function OptimizationStatus({
  trip,
  showFinalize = true,
}: {
  trip: Trip;
  showFinalize?: boolean;
}) {
  const optimize = useTripStore((s) => s.optimize);
  const finalize = useTripStore((s) => s.finalize);
  const setView = useTripStore((s) => s.setView);
  const action = useAction();
  const { status, result, error } = trip.optimization;
  const onOptimize = (request: OptimizeRequest) =>
    void action.run(() => optimize(trip.id, request));
  const waiting = status === "pending" || status === "running";

  return (
    <section
      data-testid="optimization-status"
      data-status={status}
      aria-label="Schedule optimization"
      style={{ borderLeft: "2px solid var(--primary)", paddingLeft: 12, margin: "12px 0" }}
    >
      <div className="eyebrow">Schedule optimization</div>
      <Typography role="status" sx={{ fontWeight: 600 }}>
        {status}
      </Typography>

      {status === "pending" && (
        <Typography>Waiting for place data before building your schedule.</Typography>
      )}
      {status === "running" && <Typography>Working out your schedule.</Typography>}
      {waiting && (
        <LinearProgress aria-label="Optimizing the schedule" sx={{ my: 1, maxWidth: 360 }} />
      )}

      {status === "solved" && result && (
        <Typography>
          {result.quality === "optimal" && "This schedule is optimal: proven best by the solver."}
          {result.quality === "good" &&
            "This is a good schedule: the best one found within the time limit."}
          {result.quality === "heuristic" && "This schedule came from a heuristic."}
        </Typography>
      )}

      {status === "fallback" && (
        <Typography>
          This schedule came from a heuristic, not the optimizer.
          {result?.diagnostics.fallbackReason && (
            <>
              {" "}
              Reason: <span className="plain-text">{result.diagnostics.fallbackReason}</span>
            </>
          )}
        </Typography>
      )}

      {status === "infeasible" && (
        <>
          <Typography>
            No schedule can fit all your must-see places. You can change the trip:
          </Typography>
          <InfeasibleOptions trip={trip} disabled={action.pending} onOptimize={onOptimize} />
        </>
      )}

      {status === "failed" && (
        <>
          <Alert severity="error" sx={{ my: 1 }}>
            <span className="plain-text">{error ?? "The optimizer failed without an error."}</span>
          </Alert>
          <Button variant="outlined" disabled={action.pending} onClick={() => onOptimize({})}>
            Run the optimizer again
          </Button>
        </>
      )}

      {action.pending && (
        <Typography role="status" sx={{ mt: 1 }}>
          Sending your change...
        </Typography>
      )}
      {action.error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {action.error}
        </Alert>
      )}

      {showFinalize && result && (
        <div style={{ marginTop: 12 }}>
          <Button
            variant="contained"
            disabled={action.pending || waiting}
            onClick={() =>
              trip.step === "final" ? setView(null) : void action.run(() => finalize(trip.id))
            }
          >
            View final schedule
          </Button>
        </div>
      )}
    </section>
  );
}
