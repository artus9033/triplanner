import { Typography } from "@mui/material";
import type { Trip } from "@triplanner/shared";
import { OptimizationStatus } from "./OptimizationStatus";
import { PlaceCard } from "./PlaceCard";

/** Steps 2 and 3 are one screen: cards fill in as bots finish, while the schedule is solved. */
export function Review({ trip }: { trip: Trip }) {
  const done = trip.places.filter((place) => place.status === "done").length;
  const failed = trip.places.filter((place) => place.status === "failed").length;

  return (
    <section aria-label="Place review">
      <Typography variant="h2" gutterBottom>
        {trip.step === "place_data" ? "Gathering place details" : "Review your places"}
      </Typography>
      <Typography role="status" color="text.secondary">
        {trip.places.length === 0
          ? "Waiting for the first place to be queued."
          : `${done} of ${trip.places.length} places ready${failed ? `, ${failed} failed` : ""}.`}
      </Typography>
      <OptimizationStatus trip={trip} />
      <div className="place-grid">
        {trip.places.map((place) => (
          <PlaceCard key={place.id} tripId={trip.id} place={place} state={trip.state} />
        ))}
      </div>
    </section>
  );
}
