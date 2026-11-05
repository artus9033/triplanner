import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEventSource, stubEventSource } from "./test/fixtures";
import {
  POLL_WHEN_CONNECTED_MS,
  POLL_WHEN_DISCONNECTED_MS,
  RECONNECT_DELAY_MS,
  subscribeTripEvents,
} from "./tripEvents";

beforeEach(() => {
  vi.useFakeTimers();
  stubEventSource();
});

const event = { type: "trip.updated", tripId: "t1" };

describe("subscribeTripEvents", () => {
  it("connects to the trip's stream and calls back on trip.updated", () => {
    const onUpdate = vi.fn();
    const stop = subscribeTripEvents("t1", onUpdate);
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe("/api/trips/t1/events");
    source.emit(event);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    stop();
  });

  it("ignores other trips' events and malformed frames", () => {
    const onUpdate = vi.fn();
    const stop = subscribeTripEvents("t1", onUpdate);
    const source = FakeEventSource.instances[0]!;
    source.emit({ type: "trip.updated", tripId: "other" });
    source.onmessage?.(new MessageEvent("message", { data: "{not json" }));
    expect(onUpdate).not.toHaveBeenCalled();
    stop();
  });

  it("catches up on connect and slows polling down while connected", () => {
    const onUpdate = vi.fn();
    const stop = subscribeTripEvents("t1", onUpdate);
    FakeEventSource.instances[0]!.onopen?.();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(POLL_WHEN_DISCONNECTED_MS * 2);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(POLL_WHEN_CONNECTED_MS);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    stop();
  });

  it("polls fast when the stream errors, and returns to slow on reconnect", () => {
    const onUpdate = vi.fn();
    const stop = subscribeTripEvents("t1", onUpdate);
    const source = FakeEventSource.instances[0]!;
    source.onopen?.();
    onUpdate.mockClear();
    source.onerror?.();
    vi.advanceTimersByTime(POLL_WHEN_DISCONNECTED_MS * 3);
    expect(onUpdate).toHaveBeenCalledTimes(3);
    source.onopen?.();
    onUpdate.mockClear();
    vi.advanceTimersByTime(POLL_WHEN_DISCONNECTED_MS * 3);
    expect(onUpdate).not.toHaveBeenCalled();
    stop();
  });

  it("opens a new stream after the browser gives up on the old one", () => {
    const stop = subscribeTripEvents("t1", vi.fn());
    const source = FakeEventSource.instances[0]!;
    source.readyState = 2;
    source.onerror?.();
    expect(source.closed).toBe(true);
    vi.advanceTimersByTime(RECONNECT_DELAY_MS);
    expect(FakeEventSource.instances).toHaveLength(2);
    stop();
  });

  it("falls back to polling when EventSource does not exist", () => {
    vi.stubGlobal("EventSource", undefined);
    const onUpdate = vi.fn();
    const stop = subscribeTripEvents("t1", onUpdate);
    vi.advanceTimersByTime(POLL_WHEN_DISCONNECTED_MS * 2);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops everything on unsubscribe", () => {
    const onUpdate = vi.fn();
    const stop = subscribeTripEvents("t1", onUpdate);
    const source = FakeEventSource.instances[0]!;
    stop();
    expect(source.closed).toBe(true);
    vi.advanceTimersByTime(POLL_WHEN_CONNECTED_MS * 2);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
