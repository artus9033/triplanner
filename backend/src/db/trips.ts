import { randomUUID } from "node:crypto";
import {
  emptyTripState,
  TripSchema,
  type Trip,
  type TripPlace,
  type TripSummary,
} from "@triplanner/shared";
import { getDb } from "./mongo";

type TripDoc = Omit<Trip, "id"> & { _id: string };

const trips = () => getDb().collection<TripDoc>("trips");

const toTrip = ({ _id, ...rest }: TripDoc): Trip => TripSchema.parse({ id: _id, ...rest });

export const newTrip = (title = "New trip"): Trip => {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title,
    step: "intake",
    state: emptyTripState(),
    messages: [],
    proposals: { status: "idle", items: [], error: null },
    places: [],
    optimization: {
      status: "pending",
      startedAt: null,
      instanceHash: null,
      result: null,
      error: null,
    },
    createdAt: now,
    updatedAt: now,
  };
};

export const insertTrip = async (trip: Trip): Promise<Trip> => {
  const { id, ...rest } = TripSchema.parse(trip);
  await trips().insertOne({ _id: id, ...rest });
  return trip;
};

export const createTrip = (title?: string): Promise<Trip> => insertTrip(newTrip(title));

export const getTrip = async (id: string): Promise<Trip | null> => {
  const doc = await trips().findOne({ _id: id });
  return doc ? toTrip(doc) : null;
};

export const listTrips = async (): Promise<TripSummary[]> => {
  const docs = await trips()
    .find({}, { projection: { title: 1, step: 1, updatedAt: 1 } })
    .sort({ updatedAt: -1 })
    .toArray();
  return docs.map((d) => ({ id: d._id, title: d.title, step: d.step, updatedAt: d.updatedAt }));
};

export const deleteTrip = async (id: string): Promise<boolean> =>
  (await trips().deleteOne({ _id: id })).deletedCount === 1;

/** Sets top-level fields atomically and returns the updated trip. */
export const patchTrip = async (
  id: string,
  patch: Partial<Omit<Trip, "id" | "createdAt">>,
): Promise<Trip | null> => {
  const doc = await trips().findOneAndUpdate(
    { _id: id },
    { $set: { ...patch, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" },
  );
  return doc ? toTrip(doc) : null;
};

/** Updates one place atomically, so concurrent bots do not overwrite each other. */
export const patchPlace = async (
  id: string,
  placeId: string,
  patch: Partial<Omit<TripPlace, "id">>,
): Promise<Trip | null> => {
  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  for (const [key, value] of Object.entries(patch)) set[`places.$.${key}`] = value;
  const doc = await trips().findOneAndUpdate(
    { _id: id, "places.id": placeId },
    { $set: set },
    { returnDocument: "after" },
  );
  return doc ? toTrip(doc) : null;
};

/** Trips with work marked in flight, for recovery after a restart. */
export const listRunningTripIds = async (): Promise<string[]> => {
  const docs = await trips()
    .find(
      {
        $or: [
          { "places.status": { $in: ["queued", "running"] } },
          { "proposals.status": "running" },
          { "optimization.status": "running" },
        ],
      },
      { projection: { _id: 1 } },
    )
    .toArray();
  return docs.map((d) => d._id);
};
