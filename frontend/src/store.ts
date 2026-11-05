import type { Trip, TripStep, TripSummary } from "@triplanner/shared";
import { create } from "zustand";
import { api, ApiRequestError, errorText } from "./api";

export interface LoadState {
  status: "loading" | "ready" | "failed" | "missing";
  /** Text of the most recent failed fetch. Cached data, if any, stays on screen with it. */
  error: string | null;
}

export interface ChatSlot {
  draft: string;
  /** The message being sent, shown while the POST is pending. */
  pending: string | null;
  error: string | null;
}

export const emptyChat: ChatSlot = { draft: "", pending: null, error: null };

interface TripStoreState {
  summaries: TripSummary[];
  listStatus: "idle" | "loading" | "ready" | "failed";
  listError: string | null;
  /** Cache of server state, by trip id. The server stays the source of truth. */
  trips: Record<string, Trip>;
  load: Record<string, LoadState>;
  chats: Record<string, ChatSlot>;
  currentTripId: string | null;
  /** View-only state for the open trip. Cleared on switching trips. */
  hoveredPlaceId: string | null;
  selectedPlaceId: string | null;
  viewOverride: TripStep | null;

  loadTrips: () => Promise<void>;
  createTrip: () => Promise<Trip>;
  deleteTrip: (id: string) => Promise<void>;
  openTrip: (id: string) => Promise<void>;
  refetchTrip: (id: string) => Promise<void>;
  applyTrip: (trip: Trip) => void;
  setDraft: (id: string, draft: string) => void;
  sendMessage: (id: string, content: string) => Promise<void>;
  retryProposals: (id: string) => Promise<void>;
  confirmProposals: (id: string, placeIds: string[]) => Promise<void>;
  retryPlace: (id: string, placeId: string) => Promise<void>;
  optimize: (id: string, request: Parameters<typeof api.optimize>[1]) => Promise<void>;
  finalize: (id: string) => Promise<void>;
  setHovered: (placeId: string | null) => void;
  setSelected: (placeId: string | null) => void;
  setView: (view: TripStep | null) => void;
}

const initialData = {
  summaries: [] as TripSummary[],
  listStatus: "idle" as const,
  listError: null,
  trips: {},
  load: {},
  chats: {},
  currentTripId: null,
  hoveredPlaceId: null,
  selectedPlaceId: null,
  viewOverride: null,
};

/** One fetch per trip at a time. Events that arrive during a fetch trigger one more afterwards. */
const fetching = new Map<string, { again: boolean }>();

const isOlder = (next: Trip, cached: Trip | undefined): boolean =>
  cached !== undefined && Date.parse(next.updatedAt) < Date.parse(cached.updatedAt);

export const useTripStore = create<TripStoreState>((set, get) => {
  const patchChat = (id: string, patch: Partial<ChatSlot>) =>
    set((s) => ({ chats: { ...s.chats, [id]: { ...(s.chats[id] ?? emptyChat), ...patch } } }));

  return {
    ...initialData,

    loadTrips: async () => {
      set({ listStatus: "loading", listError: null });
      try {
        const summaries = await api.listTrips();
        set({ summaries, listStatus: "ready" });
      } catch (cause) {
        set({ listStatus: "failed", listError: errorText(cause) });
      }
    },

    createTrip: async () => {
      const trip = await api.createTrip();
      get().applyTrip(trip);
      return trip;
    },

    deleteTrip: async (id) => {
      await api.deleteTrip(id);
      set((s) => {
        const { [id]: _trip, ...trips } = s.trips;
        const { [id]: _chat, ...chats } = s.chats;
        const { [id]: _load, ...load } = s.load;
        return { trips, chats, load, summaries: s.summaries.filter((t) => t.id !== id) };
      });
    },

    openTrip: async (id) => {
      set((s) => ({
        currentTripId: id,
        hoveredPlaceId: null,
        selectedPlaceId: null,
        viewOverride: null,
        load: {
          ...s.load,
          [id]: { status: s.trips[id] ? "ready" : "loading", error: null },
        },
      }));
      await get().refetchTrip(id);
    },

    refetchTrip: async (id) => {
      const running = fetching.get(id);
      if (running) {
        running.again = true;
        return;
      }
      const slot = { again: false };
      fetching.set(id, slot);
      try {
        const trip = await api.getTrip(id);
        get().applyTrip(trip);
        set((s) => ({ load: { ...s.load, [id]: { status: "ready", error: null } } }));
      } catch (cause) {
        const missing = cause instanceof ApiRequestError && cause.status === 404;
        set((s) => {
          const status = missing ? "missing" : s.trips[id] ? "ready" : "failed";
          return { load: { ...s.load, [id]: { status, error: errorText(cause) } } };
        });
      } finally {
        fetching.delete(id);
      }
      if (slot.again) await get().refetchTrip(id);
    },

    applyTrip: (trip) => {
      set((s) => {
        const cached = s.trips[trip.id];
        if (isOlder(trip, cached)) return {};
        const summary: TripSummary = {
          id: trip.id,
          title: trip.title,
          step: trip.step,
          updatedAt: trip.updatedAt,
        };
        const known = s.summaries.some((t) => t.id === trip.id);
        const stepMoved = cached !== undefined && cached.step !== trip.step;
        return {
          trips: { ...s.trips, [trip.id]: trip },
          summaries: known
            ? s.summaries.map((t) => (t.id === trip.id ? summary : t))
            : [summary, ...s.summaries],
          viewOverride: stepMoved && s.currentTripId === trip.id ? null : s.viewOverride,
        };
      });
    },

    setDraft: (id, draft) => patchChat(id, { draft }),

    sendMessage: async (id, content) => {
      if ((get().chats[id] ?? emptyChat).pending !== null) return;
      patchChat(id, { pending: content, error: null, draft: "" });
      try {
        get().applyTrip(await api.sendMessage(id, content));
        patchChat(id, { pending: null });
      } catch (cause) {
        // Whatever was typed meanwhile is newer than the failed message, so it wins.
        const draft = (get().chats[id] ?? emptyChat).draft || content;
        patchChat(id, { pending: null, error: errorText(cause), draft });
      }
    },

    retryProposals: async (id) => get().applyTrip(await api.retryProposals(id)),
    confirmProposals: async (id, placeIds) =>
      get().applyTrip(await api.confirmProposals(id, placeIds)),
    retryPlace: async (id, placeId) => get().applyTrip(await api.retryPlace(id, placeId)),
    optimize: async (id, request) => get().applyTrip(await api.optimize(id, request)),
    finalize: async (id) => {
      get().applyTrip(await api.finalize(id));
      set({ viewOverride: null });
    },

    setHovered: (placeId) => set({ hoveredPlaceId: placeId }),
    setSelected: (placeId) => set({ selectedPlaceId: placeId }),
    setView: (view) => set({ viewOverride: view, hoveredPlaceId: null, selectedPlaceId: null }),
  };
});

export const resetTripStore = (): void => {
  fetching.clear();
  useTripStore.setState(initialData);
};
