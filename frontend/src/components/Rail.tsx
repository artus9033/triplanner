import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import { Alert, Button, IconButton, Tooltip } from "@mui/material";
import type { TripStep, TripSummary } from "@triplanner/shared";
import { useCallback, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router";
import { useTripStore } from "../store";
import { useAction } from "../lib/useAction";

export const STEP_NAMES: Record<TripStep, string> = {
  intake: "Intake",
  refinement: "Choosing places",
  place_data: "Gathering data",
  review: "Review",
  final: "Final schedule",
};

export const useCreateTrip = () => {
  const navigate = useNavigate();
  const createTrip = useTripStore((s) => s.createTrip);
  const { pending, error, run } = useAction();
  const start = useCallback(
    () =>
      run(async () => {
        const trip = await createTrip();
        await navigate(`/trips/${encodeURIComponent(trip.id)}`);
      }),
    [run, createTrip, navigate],
  );
  return { pending, error, start };
};

function TripRow({ trip, current }: { trip: TripSummary; current: boolean }) {
  const navigate = useNavigate();
  const deleteTrip = useTripStore((s) => s.deleteTrip);
  const [confirming, setConfirming] = useState(false);
  const { pending, error, run } = useAction();
  const title = trip.title || "Untitled trip";

  const onDelete = () =>
    run(async () => {
      await deleteTrip(trip.id);
      if (current) await navigate("/");
    });

  return (
    <li>
      <div className="trip-row" data-current={current}>
        <RouterLink
          className="trip-link"
          to={`/trips/${encodeURIComponent(trip.id)}`}
          aria-current={current ? "page" : undefined}
        >
          <span className="trip-title">{title}</span>
          <span className="trip-step">{STEP_NAMES[trip.step]}</span>
        </RouterLink>
        {!confirming && (
          <Tooltip title={`Delete ${title}`}>
            <IconButton
              size="small"
              aria-label={`Delete ${title}`}
              onClick={() => setConfirming(true)}
            >
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </div>
      {confirming && (
        <div style={{ padding: "0 0 8px 10px", display: "flex", gap: 4 }}>
          <Button
            size="small"
            variant="contained"
            color="error"
            disabled={pending}
            onClick={() => void onDelete()}
          >
            {pending ? "Deleting..." : "Delete"}
          </Button>
          <Button size="small" color="inherit" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </div>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}
    </li>
  );
}

export function Rail({ currentId }: { currentId?: string }) {
  const summaries = useTripStore((s) => s.summaries);
  const listStatus = useTripStore((s) => s.listStatus);
  const listError = useTripStore((s) => s.listError);
  const loadTrips = useTripStore((s) => s.loadTrips);
  const { pending, error, start } = useCreateTrip();

  return (
    <nav className="rail" aria-label="Trips">
      <RouterLink className="brand" to="/">
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" />
          <path d="M16 5l3.5 11L16 27l-3.5-11z" fill="currentColor" />
        </svg>
        Triplanner
      </RouterLink>
      <Button
        data-testid="new-trip"
        variant="outlined"
        disabled={pending}
        onClick={() => void start()}
      >
        {pending ? "Creating..." : "New trip"}
      </Button>
      {error && <Alert severity="error">{error}</Alert>}
      <div>
        <div className="eyebrow" style={{ marginBottom: 6 }}>
          Your trips
        </div>
        <ul className="trip-list" data-testid="trip-list">
          {summaries.map((trip) => (
            <TripRow key={trip.id} trip={trip} current={trip.id === currentId} />
          ))}
        </ul>
        {summaries.length === 0 && listStatus === "loading" && <p>Loading trips...</p>}
        {summaries.length === 0 && listStatus === "ready" && <p>No trips yet.</p>}
        {listStatus === "failed" && (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={() => void loadTrips()}>
                Retry
              </Button>
            }
          >
            Could not load trips: {listError}
          </Alert>
        )}
      </div>
    </nav>
  );
}
