import { EventEmitter } from "node:events";
import type { TripEvent } from "@triplanner/shared";

const bus = new EventEmitter();
bus.setMaxListeners(0);

export const publishTripUpdate = (tripId: string): void => {
  const event: TripEvent = { type: "trip.updated", tripId };
  bus.emit(tripId, event);
};

export const subscribeTrip = (
  tripId: string,
  listener: (event: TripEvent) => void,
): (() => void) => {
  bus.on(tripId, listener);
  return () => bus.off(tripId, listener);
};
