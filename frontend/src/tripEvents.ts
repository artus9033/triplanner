import { TripEventSchema } from "@triplanner/shared";

export const POLL_WHEN_DISCONNECTED_MS = 3_000;
/** Also polled while connected, in case a proxy silently swallows the stream. */
export const POLL_WHEN_CONNECTED_MS = 20_000;
export const RECONNECT_DELAY_MS = 10_000;

/**
 * Calls `onUpdate` whenever the trip may have changed: on a trip.updated event, on every
 * (re)connect to catch up on what was missed, and on a timer. While the stream is down the timer
 * runs fast, so the UI keeps moving without SSE. Returns the unsubscribe function.
 */
export const subscribeTripEvents = (tripId: string, onUpdate: () => void): (() => void) => {
  let source: EventSource | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const poll = (intervalMs: number) => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(onUpdate, intervalMs);
  };

  const connect = () => {
    if (closed) return;
    if (typeof EventSource === "undefined") return;
    try {
      source = new EventSource(`/api/trips/${encodeURIComponent(tripId)}/events`);
    } catch {
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      return;
    }
    const current = source;
    current.onopen = () => {
      poll(POLL_WHEN_CONNECTED_MS);
      onUpdate();
    };
    const onEvent = (event: MessageEvent) => {
      try {
        const parsed = TripEventSchema.safeParse(JSON.parse(String(event.data)));
        if (parsed.success && parsed.data.tripId === tripId) onUpdate();
      } catch {
        // Malformed frame: the timer still catches any real change.
      }
    };
    current.onmessage = onEvent;
    current.addEventListener("trip.updated", onEvent as EventListener);
    current.onerror = () => {
      poll(POLL_WHEN_DISCONNECTED_MS);
      // CONNECTING means the browser is retrying by itself. CLOSED means it gave up, for example
      // on a 401 or a 5xx, so retrying is up to us.
      if (current.readyState === 2) {
        current.close();
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      }
    };
  };

  poll(POLL_WHEN_DISCONNECTED_MS);
  connect();

  return () => {
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    source?.close();
  };
};
