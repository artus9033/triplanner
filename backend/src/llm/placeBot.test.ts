import { emptyTripState, type PlaceData, type TripState } from "@triplanner/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLACE_SEARCH_MAX_USES } from "../config/llm";
import { setAnthropicClientForTest } from "./client";
import { LlmError } from "./errors";
import { postValidatePlace, researchPlace, withBudget } from "./placeBot";
import {
  citedText,
  fakeClient,
  hangUntilAborted,
  jsonResponse,
  message,
  type Reply,
} from "./testApi";

const state: TripState = {
  ...emptyTripState(),
  city: "Paris",
  start_date: "2026-11-10",
  end_date: "2026-11-11",
};

const place: PlaceData = {
  place: "Louvre",
  category: "museum",
  address: "Rue de Rivoli",
  lat: 48.86,
  lng: 2.33,
  phone: null,
  website: "https://www.louvre.fr/",
  hours: [
    { date: "2026-11-10", start: "9:00", end: "18:00" },
    { date: "2026-11-11", start: "09:00", end: "21:00" },
    { date: "2026-11-12", start: "09:00", end: "18:00" },
    { date: "2026-11-11", start: "closed", end: "closed" },
  ],
  description: "A museum.",
  visit_duration_min: null,
  google_place_id: null,
  google_maps_url: "javascript:alert(1)",
  place_image_url: "ftp://x/y.png",
  tickets: [],
  needs_reservation: true,
};

const research = message({ content: [citedText("Notes", "https://www.louvre.fr/")] });
const extracted = message({ content: [{ type: "text", text: JSON.stringify(place) }] });

const useReplies = (replies: Reply[]) => {
  const { client, requests } = fakeClient(replies);
  setAnthropicClientForTest(client);
  return requests;
};

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  setAnthropicClientForTest(null);
  vi.restoreAllMocks();
});

describe("researchPlace", () => {
  it("runs research with the tool, then extract without tools, and post-validates", async () => {
    const requests = useReplies([research, extracted]);
    const result = await researchPlace({ name: "Louvre", note: "Richelieu wing", state });

    expect(requests).toHaveLength(2);
    expect(requests[0]!.body.tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: PLACE_SEARCH_MAX_USES },
    ]);
    expect(requests[1]!.body).not.toHaveProperty("tools");

    expect(result.data.hours).toEqual([
      { date: "2026-11-10", start: "09:00", end: "18:00" },
      { date: "2026-11-11", start: "09:00", end: "21:00" },
    ]);
    expect(result.data.website).toBe("https://www.louvre.fr/");
    expect(result.data.google_maps_url).toBeNull();
    expect(result.data.place_image_url).toBeNull();
    expect(result.sources).toEqual([{ url: "https://www.louvre.fr/", title: "Title" }]);
    expect(result.model).toBe("claude-opus-5-5");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("the prompts carry the plan's rules", async () => {
    const requests = useReplies([research, extracted]);
    await researchPlace({ name: "Louvre", note: "Richelieu wing", state });
    const { system, messages, tools } = requests[0]!.body;
    expect(system).toMatch(/official website/i);
    expect(system).toMatch(/1 minute/);
    expect(system).toMatch(/unknown/i);
    expect(system).toMatch(/never invent/i);
    expect(system).toMatch(/untrusted/i);
    expect(system).toMatch(/ignore any instructions/i);
    expect(messages[0].content).toContain("2026-11-10");
    expect(messages[0].content).toContain("2026-11-11");
    expect(messages[0].content).toContain("Richelieu wing");
    expect(tools[0]).not.toHaveProperty("allowed_domains");
    expect(requests[1]!.body.system).toMatch(/ignore any instructions/i);
  });

  it("fails without valid dates, before any API call", async () => {
    const requests = useReplies([research]);
    await expect(
      researchPlace({ name: "x", note: null, state: emptyTripState() }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(requests).toHaveLength(0);
  });

  it("over-long description fails the place", async () => {
    useReplies([
      research,
      message({
        content: [
          { type: "text", text: JSON.stringify({ ...place, description: "x".repeat(121) }) },
        ],
      }),
    ]);
    await expect(researchPlace({ name: "x", note: null, state })).rejects.toMatchObject({
      code: "extract_failed",
    });
  });
});

describe("the time budget", () => {
  it("a hung research call times out", async () => {
    const requests = useReplies([hangUntilAborted]);
    const startedAt = Date.now();
    await expect(
      researchPlace({ name: "x", note: null, state, budgetMs: 50 }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(requests).toHaveLength(1);
  });

  it("covers research and extract together with one signal", async () => {
    const delayed = () =>
      new Promise<Response>((resolve) => setTimeout(() => resolve(jsonResponse(research)), 60));
    const requests = useReplies([delayed, hangUntilAborted]);
    const startedAt = Date.now();
    await expect(
      researchPlace({ name: "x", note: null, state, budgetMs: 120 }),
    ).rejects.toMatchObject({ code: "timeout" });
    // Research used part of the budget, and extract was stopped by the same timer: a per-call
    // timeout of 120ms would have ended at 180ms or later.
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body).not.toHaveProperty("tools");
    expect(Date.now() - startedAt).toBeLessThan(175);
  });

  it("the signal also stops SDK retries", async () => {
    const overloaded = () =>
      Promise.resolve(
        jsonResponse({ type: "error", error: { type: "overloaded_error", message: "busy" } }, 529),
      );
    const requests = useReplies([overloaded]);
    await expect(
      researchPlace({ name: "x", note: null, state, budgetMs: 100 }),
    ).rejects.toMatchObject({ code: "timeout" });
    const attemptsAtTimeout = requests.length;
    expect(attemptsAtTimeout).toBeGreaterThanOrEqual(1);
    // The SDK's first backoff is at least ~375ms, so nothing further may start after the abort.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(requests.length).toBe(attemptsAtTimeout);
  });

  it("a caller's abort stops the work too, and is not reported as a timeout", async () => {
    useReplies([hangUntilAborted]);
    const parent = new AbortController();
    const promise = researchPlace({ name: "x", note: null, state, signal: parent.signal });
    setTimeout(() => parent.abort(), 20);
    await expect(promise).rejects.toMatchObject({
      code: "api",
      userMessage: "The request was cancelled.",
    });
  });

  it("withBudget stops even work that ignores the signal, and passes results and errors through", async () => {
    await expect(withBudget(20, () => new Promise(() => {}))).rejects.toMatchObject({
      code: "timeout",
    });
    await expect(withBudget(1000, async () => 5)).resolves.toBe(5);
    const boom = new LlmError("refusal");
    await expect(withBudget(1000, () => Promise.reject(boom))).rejects.toBe(boom);
  });
});

describe("postValidatePlace", () => {
  it("drops hours outside dates and non-http(s) URLs", () => {
    const out = postValidatePlace(place, ["2026-11-10"]);
    expect(out.hours).toEqual([{ date: "2026-11-10", start: "09:00", end: "18:00" }]);
    expect(out.google_maps_url).toBeNull();
  });
});
