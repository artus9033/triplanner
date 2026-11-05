import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  OptimizeRequest,
  PlaceProposal,
  Trip,
  TripPlace,
} from "@triplanner/shared";
import { PROPOSAL_TIME_BUDGET_MS } from "../config/llm";
import { getTrip, listRunningTripIds, patchPlace, patchTrip } from "../db/trips";
import type { AppDeps } from "./deps";
import { HttpError, userMessageOf } from "./errors";
import { publishTripUpdate } from "./events";

const message = (role: ChatMessage["role"], content: string): ChatMessage => ({
  id: randomUUID(),
  role,
  content,
  createdAt: new Date().toISOString(),
});

export const toTripPlace = (
  place: { name: string; note: string | null; must: boolean },
  rank: number,
): TripPlace => ({
  id: randomUUID(),
  name: place.name,
  note: place.note,
  must: place.must,
  rank,
  status: "queued",
  error: null,
  data: null,
  sources: [],
  model: null,
  durationMs: null,
});

const INTERRUPTED = "Interrupted by a server restart. Retry when you are ready.";

export type TripFlow = ReturnType<typeof createTripFlow>;

export const createTripFlow = (deps: AppDeps) => {
  /** Trips with a chat turn in flight, to reject double sends. */
  const chatBusy = new Set<string>();
  /** Running place bots per trip. Optimization starts when this drains. */
  const activeBots = new Map<string, number>();
  /** Solver runs per trip: a request arriving during a run re-solves after it. */
  const solving = new Map<string, { rerun: boolean }>();
  /** Background work, so tests and shutdown can wait for it. */
  const background = new Set<Promise<unknown>>();

  const track = (work: Promise<unknown>): void => {
    background.add(work);
    void work.finally(() => background.delete(work));
  };

  const requireTrip = async (id: string): Promise<Trip> => {
    const trip = await getTrip(id);
    if (!trip) throw new HttpError(404, "Trip not found");
    return trip;
  };

  const save = async (id: string, patch: Parameters<typeof patchTrip>[1]): Promise<Trip> => {
    const trip = await patchTrip(id, patch);
    if (!trip) throw new HttpError(404, "Trip not found");
    publishTripUpdate(id);
    return trip;
  };

  const runOptimization = async (tripId: string): Promise<void> => {
    const current = solving.get(tripId);
    if (current) {
      current.rerun = true;
      return;
    }
    const run = { rerun: false };
    solving.set(tripId, run);
    try {
      do {
        run.rerun = false;
        const trip = await requireTrip(tripId);
        if (!trip.places.some((p) => p.status === "done")) {
          await save(tripId, {
            optimization: {
              status: "failed",
              startedAt: null,
              instanceHash: null,
              result: null,
              error: "No place has data yet, so there is nothing to schedule.",
            },
          });
          continue;
        }
        const startedAt = new Date().toISOString();
        await save(tripId, {
          optimization: { ...trip.optimization, status: "running", startedAt, error: null },
        });
        try {
          const outcome = await deps.optimizeTrip(
            { state: trip.state, places: trip.places },
            trip.solverOptions,
          );
          await save(tripId, { optimization: { ...outcome, startedAt } });
        } catch (err) {
          console.error("Optimization failed for trip", tripId, err);
          await save(tripId, {
            optimization: {
              status: "failed",
              startedAt,
              instanceHash: null,
              result: null,
              error: userMessageOf(err, "The schedule could not be computed. See the server log."),
            },
          });
        }
      } while (run.rerun);
    } finally {
      solving.delete(tripId);
    }
  };

  const researchOne = async (tripId: string, place: TripPlace, trip: Trip): Promise<void> => {
    await patchPlace(tripId, place.id, { status: "running", error: null });
    publishTripUpdate(tripId);
    try {
      const found = await deps.researchPlace({
        name: place.name,
        note: place.note,
        state: trip.state,
      });
      await patchPlace(tripId, place.id, {
        status: "done",
        error: null,
        data: found.data,
        sources: found.sources,
        model: found.model,
        durationMs: found.durationMs,
      });
    } catch (err) {
      console.error("Place research failed:", place.name, (err as Error).message);
      await patchPlace(tripId, place.id, {
        status: "failed",
        error: userMessageOf(err, "Could not gather data for this place. Retry when ready."),
      });
    }
    publishTripUpdate(tripId);
  };

  /** Starts bots in the background. When a trip's last bot ends, review and solving begin. */
  const startBots = (trip: Trip, places: TripPlace[]): void => {
    activeBots.set(trip.id, (activeBots.get(trip.id) ?? 0) + places.length);
    track(
      deps
        .runBotPool(places, async (place) => {
          try {
            await researchOne(trip.id, place, trip);
          } finally {
            activeBots.set(trip.id, (activeBots.get(trip.id) ?? 1) - 1);
          }
        })
        .then(async () => {
          if ((activeBots.get(trip.id) ?? 0) > 0) return;
          activeBots.delete(trip.id);
          const latest = await requireTrip(trip.id);
          // Solving and reviewing run at the same time: the review view is open while this runs.
          if (latest.step === "place_data") await save(trip.id, { step: "review" });
          await runOptimization(trip.id);
        })
        .catch((err) => console.error("Bot pool failed for trip", trip.id, err)),
    );
  };

  const startProposals = (trip: Trip): void => {
    track(
      deps
        .proposePlaces({
          state: trip.state,
          messages: trip.messages,
          signal: AbortSignal.timeout(PROPOSAL_TIME_BUDGET_MS),
        })
        .then(async (items: PlaceProposal[]) => {
          if (items.length === 0)
            throw new HttpError(502, "The search found no places. Try again.");
          await save(trip.id, { proposals: { status: "ready", items, error: null } });
        })
        .catch(async (err) => {
          console.error("Proposals failed for trip", trip.id, (err as Error).message);
          await save(trip.id, {
            proposals: {
              status: "failed",
              items: [],
              error: userMessageOf(err, "Could not search for places. Try again."),
            },
          });
        }),
    );
  };

  const namedPlaces = (trip: Trip): TripPlace[] =>
    trip.state.named_places.map((p, i) => toTripPlace({ ...p, must: true }, i + 1));

  return {
    /** Lets tests and shutdown wait until background bots, searches and solves are done. */
    idle: async (): Promise<void> => {
      while (background.size > 0) await Promise.allSettled([...background]);
    },

    /**
     * Step 0. Both messages are stored only once the reply exists, so a failed turn can be resent
     * from the input box without duplicating anything.
     */
    sendMessage: async (tripId: string, content: string): Promise<Trip> => {
      if (chatBusy.has(tripId)) throw new HttpError(409, "Still answering your last message.");
      chatBusy.add(tripId);
      try {
        const trip = await requireTrip(tripId);
        if (trip.step !== "intake") {
          throw new HttpError(409, "This trip's intake is finished, so the chat is closed.");
        }
        const turn = await deps.advanceIntake({
          state: trip.state,
          messages: trip.messages,
          userMessage: content,
          today: new Date().toISOString().slice(0, 10),
        });
        const messages = [
          ...trip.messages,
          message("user", content),
          message("assistant", turn.reply),
        ];
        const title = turn.state.city ?? trip.title;
        if (!turn.complete) {
          return await save(tripId, { messages, state: turn.state, title });
        }
        const needsSearch = turn.state.needs_search || turn.state.named_places.length === 0;
        if (needsSearch) {
          const updated = await save(tripId, {
            messages,
            state: turn.state,
            title,
            step: "refinement",
            proposals: { status: "running", items: [], error: null },
          });
          startProposals(updated);
          return updated;
        }
        // Everything was named, so step 1 is skipped.
        const updated = await save(tripId, {
          messages,
          state: turn.state,
          title,
          step: "place_data",
          places: namedPlaces({ ...trip, state: turn.state }),
        });
        startBots(updated, updated.places);
        return updated;
      } finally {
        chatBusy.delete(tripId);
      }
    },

    retryProposals: async (tripId: string): Promise<Trip> => {
      const trip = await requireTrip(tripId);
      if (trip.step !== "refinement" || trip.proposals.status === "running") {
        throw new HttpError(409, "Proposals cannot be retried right now.");
      }
      const updated = await save(tripId, {
        proposals: { status: "running", items: [], error: null },
      });
      startProposals(updated);
      return updated;
    },

    /** Step 1. Named places come first and stay mandatory; picks keep the on-screen order. */
    confirmProposals: async (tripId: string, placeIds: string[]): Promise<Trip> => {
      const trip = await requireTrip(tripId);
      if (trip.step !== "refinement" || trip.proposals.status === "running") {
        throw new HttpError(409, "There are no proposals to confirm right now.");
      }
      const known = new Set(trip.proposals.items.map((p) => p.id));
      const unknown = placeIds.find((id) => !known.has(id));
      if (unknown) throw new HttpError(400, "That place is not one of the proposals.");
      const picked = new Set(placeIds);
      const named = namedPlaces(trip);
      const chosen = trip.proposals.items
        .filter((p) => picked.has(p.id))
        .map((p, i) =>
          toTripPlace({ name: p.name, note: null, must: false }, named.length + i + 1),
        );
      const places = [...named, ...chosen];
      if (places.length === 0) throw new HttpError(400, "Select at least one place.");
      const updated = await save(tripId, { step: "place_data", places });
      startBots(updated, places);
      return updated;
    },

    /** Step 2. Costs money, so only ever runs on the user's explicit request. */
    retryPlace: async (tripId: string, placeId: string): Promise<Trip> => {
      const trip = await requireTrip(tripId);
      const place = trip.places.find((p) => p.id === placeId);
      if (!place) throw new HttpError(404, "Place not found");
      if (place.status !== "failed")
        throw new HttpError(409, "Only a failed place can be retried.");
      const updated = await patchPlace(tripId, placeId, { status: "queued", error: null });
      publishTripUpdate(tripId);
      startBots(trip, [{ ...place, status: "queued", error: null }]);
      return updated!;
    },

    /** Applies the user's choices from the infeasible and "not included" views, then re-solves. */
    optimize: async (tripId: string, request: OptimizeRequest): Promise<Trip> => {
      const trip = await requireTrip(tripId);
      if ((activeBots.get(tripId) ?? 0) > 0) {
        throw new HttpError(409, "Place data is still being gathered.");
      }
      if (trip.step !== "review" && trip.step !== "final") {
        throw new HttpError(409, "The schedule is not available at this step.");
      }
      const drop = new Set(request.dropPlaceIds ?? []);
      const force = new Set(request.forcePlaceIds ?? []);
      const places = trip.places
        .filter((p) => !drop.has(p.id))
        .map((p) => (force.has(p.id) ? { ...p, must: true } : p));
      const solverOptions = {
        ...trip.solverOptions,
        ...(request.allowShortening !== undefined && { allowShortening: request.allowShortening }),
        ...(request.dayWindow && { dayWindow: request.dayWindow }),
      };
      const state = request.endDate ? { ...trip.state, end_date: request.endDate } : trip.state;
      if (request.endDate && trip.state.start_date && request.endDate < trip.state.start_date) {
        throw new HttpError(400, "The end date is before the start date.");
      }

      const updated = await save(tripId, { places, solverOptions, state });
      // New dates have no hours yet. Only places left out of the last schedule are worth paying to
      // look up again; the others keep their slot on the dates they already have data for.
      if (request.endDate && request.endDate !== trip.state.end_date) {
        const droppedIds = new Set(trip.optimization.result?.dropped.map((d) => d.placeId));
        const stale = places.filter((p) => droppedIds.has(p.id));
        if (stale.length > 0) {
          for (const place of stale) await patchPlace(tripId, place.id, { status: "queued" });
          startBots(updated, stale);
          return (await getTrip(tripId))!;
        }
      }
      track(runOptimization(tripId));
      return updated;
    },

    finalize: async (tripId: string): Promise<Trip> => {
      const trip = await requireTrip(tripId);
      if (!trip.optimization.result) throw new HttpError(409, "There is no schedule to show yet.");
      return save(tripId, { step: "final" });
    },

    /**
     * Work in flight died with the previous process (the dev server restarts on every edit).
     * Paid work is marked failed for an explicit retry. Solving costs nothing, so it restarts.
     */
    recoverInterrupted: async (): Promise<void> => {
      for (const id of await listRunningTripIds()) {
        const trip = await getTrip(id);
        if (!trip) continue;
        const places = trip.places.map((p) =>
          p.status === "queued" || p.status === "running"
            ? { ...p, status: "failed" as const, error: INTERRUPTED }
            : p,
        );
        const proposals =
          trip.proposals.status === "running"
            ? { status: "failed" as const, items: [], error: INTERRUPTED }
            : trip.proposals;
        const step = trip.step === "place_data" ? ("review" as const) : trip.step;
        await save(id, { places, proposals, step });
        if (trip.step === "place_data" || trip.optimization.status === "running") {
          track(runOptimization(id));
        }
      }
    },
  };
};
