import {
  Alert,
  Button,
  Card,
  CardContent,
  Chip,
  LinearProgress,
  Stack,
  Typography,
} from "@mui/material";
import type { TripPlace, TripState } from "@triplanner/shared";
import { useAction } from "../lib/useAction";
import { useTripStore } from "../store";
import { PlaceDetails } from "./PlaceDetails";

const STATUS_COLOR = {
  queued: "default",
  running: "primary",
  done: "default",
  failed: "error",
} as const;

export function PlaceCard({
  tripId,
  place,
  state,
}: {
  tripId: string;
  place: TripPlace;
  state: TripState;
}) {
  const retryPlace = useTripStore((s) => s.retryPlace);
  const setHovered = useTripStore((s) => s.setHovered);
  const retry = useAction();

  return (
    <Card
      data-testid="place-card"
      data-place-id={place.id}
      data-status={place.status}
      onMouseEnter={() => setHovered(place.id)}
      onMouseLeave={() => setHovered(null)}
    >
      <CardContent>
        <Stack
          direction="row"
          spacing={1}
          sx={{ justifyContent: "space-between", alignItems: "flex-start", mb: 1 }}
        >
          <Typography variant="h3" component="h3" sx={{ overflowWrap: "anywhere" }}>
            {place.data?.place ?? place.name}
          </Typography>
          <Chip size="small" label={place.status} color={STATUS_COLOR[place.status]} />
        </Stack>
        {place.note && (
          <Typography variant="body2" color="text.secondary" className="plain-text" gutterBottom>
            {place.note}
          </Typography>
        )}

        {place.status === "queued" && (
          <Typography color="text.secondary">Waiting for a free bot.</Typography>
        )}
        {place.status === "running" && (
          <div role="status">
            <Typography gutterBottom>A bot is looking this place up (up to a minute).</Typography>
            <LinearProgress aria-label={`Looking up ${place.name}`} />
          </div>
        )}
        {place.status === "failed" && (
          <>
            <Alert severity="error" sx={{ mb: 1 }}>
              <span className="plain-text">{place.error ?? "The lookup failed."}</span>
            </Alert>
            <Button
              size="small"
              variant="outlined"
              disabled={retry.pending}
              onClick={() => void retry.run(() => retryPlace(tripId, place.id))}
            >
              {retry.pending ? "Retrying..." : "Retry this place"}
            </Button>
            {retry.error && (
              <Alert severity="error" sx={{ mt: 1 }}>
                {retry.error}
              </Alert>
            )}
          </>
        )}
        {place.status === "done" && <PlaceDetails place={place} state={state} />}
      </CardContent>
    </Card>
  );
}
