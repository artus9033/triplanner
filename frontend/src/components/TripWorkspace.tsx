import { Alert, Button, CircularProgress, Stack, Typography } from "@mui/material";
import type { Trip } from "@triplanner/shared";
import { useEffect, useMemo } from "react";
import { Link as RouterLink, useParams } from "react-router";
import { formatDate, formatMoney } from "../lib/format";
import { resolveView } from "../lib/steps";
import { useTripStore } from "../store";
import { subscribeTripEvents } from "../tripEvents";
import { Chat } from "./Chat";
import { FinalView, visitLabels } from "./FinalView";
import { Proposals } from "./Proposals";
import { Rail } from "./Rail";
import { Review } from "./Review";
import { StepsTimeline } from "./StepsTimeline";
import { TripMap } from "./TripMap";

const tripMeta = ({ state }: Trip): string => {
  const parts = [state.city];
  if (state.start_date) {
    parts.push(
      state.end_date && state.end_date !== state.start_date
        ? `${formatDate(state.start_date)} to ${formatDate(state.end_date)}`
        : formatDate(state.start_date),
    );
  }
  if (state.budget_answered) {
    parts.push(
      state.budget_usd === null ? "No budget limit" : `${formatMoney(state.budget_usd)} budget`,
    );
  }
  return parts.filter(Boolean).join(" · ");
};

function WorkspaceBody({ trip }: { trip: Trip }) {
  const viewOverride = useTripStore((s) => s.viewOverride);
  const view = resolveView(trip, viewOverride);
  const result = trip.optimization.result;
  const labels = useMemo(
    () => (view === "final" && result ? visitLabels(result) : {}),
    [view, result],
  );
  const meta = tripMeta(trip);
  const showMap = view === "place_data" || view === "review" || view === "final";

  return (
    <>
      <main className="main">
        <header style={{ marginBottom: 12 }}>
          <div className="eyebrow">{trip.title || "Untitled trip"}</div>
          {meta && <Typography sx={{ fontSize: "0.95rem" }}>{meta}</Typography>}
        </header>
        {view === "intake" && <Chat trip={trip} />}
        {view === "refinement" && <Proposals key={trip.id} trip={trip} />}
        {(view === "place_data" || view === "review") && <Review trip={trip} />}
        {view === "final" && <FinalView trip={trip} />}
      </main>
      <aside className="aside" aria-label="Trip progress and map">
        <StepsTimeline trip={trip} />
        {showMap && <TripMap places={trip.places} state={trip.state} labels={labels} />}
      </aside>
    </>
  );
}

function OpenTrip({ id }: { id: string }) {
  const trip = useTripStore((s) => s.trips[id]);
  const load = useTripStore((s) => s.load[id]);
  const openTrip = useTripStore((s) => s.openTrip);
  const refetchTrip = useTripStore((s) => s.refetchTrip);

  useEffect(() => {
    void openTrip(id);
    return subscribeTripEvents(id, () => void refetchTrip(id));
  }, [id, openTrip, refetchTrip]);

  if (load?.status === "missing") {
    return (
      <main className="main">
        <Alert severity="error">This trip does not exist any more: {load.error}</Alert>
        <Button component={RouterLink} to="/" sx={{ mt: 1, alignSelf: "flex-start" }}>
          Back to all trips
        </Button>
      </main>
    );
  }
  if (!trip) {
    return (
      <main className="main">
        {load?.status === "failed" ? (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={() => void refetchTrip(id)}>
                Retry
              </Button>
            }
          >
            Could not load this trip: {load.error}
          </Alert>
        ) : (
          <Stack direction="row" spacing={1} role="status" sx={{ alignItems: "center" }}>
            <CircularProgress size={18} aria-label="Loading trip" />
            <span>Loading trip...</span>
          </Stack>
        )}
      </main>
    );
  }
  return (
    <>
      {load?.error && (
        <div style={{ position: "fixed", right: 12, bottom: 12, zIndex: 1000 }}>
          <Alert severity="warning">Showing the last known state. {load.error}</Alert>
        </div>
      )}
      <WorkspaceBody trip={trip} />
    </>
  );
}

export function TripWorkspace() {
  const { id = "" } = useParams();
  return (
    <div className="shell">
      <Rail currentId={id} />
      {/* The key resets all local state on switching trips, so nothing leaks between them. */}
      <OpenTrip key={id} id={id} />
    </div>
  );
}
