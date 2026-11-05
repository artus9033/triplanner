import { emptyTripState, type TripState } from "@triplanner/shared";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_MODEL, INTAKE_EFFORT } from "../config/llm";
import { fakeFetch, jsonResponse, message } from "../llm/testApi";
import {
  advanceIntake,
  applyIntakeUpdate,
  intakePhase,
  missingFields,
  nextQuestion,
  setIntakeFetchForTest,
  type IntakeUpdate,
} from "./machine";

const today = "2026-11-05";

const blankUpdate: IntakeUpdate = {
  acknowledgement: "Great!",
  start_date: null,
  end_date: null,
  city: null,
  plans: null,
  named_places: null,
  needs_search: null,
  budget_answered: false,
  budget_amount: null,
  budget_currency: null,
};

const filled: TripState = {
  city: "Paris",
  start_date: "2026-11-10",
  end_date: "2026-11-12",
  plans: "The Louvre",
  named_places: [{ name: "Louvre", note: null }],
  needs_search: false,
  budget_answered: true,
  budget_usd: null,
};

const apply = (update: Partial<IntakeUpdate>, state: TripState = emptyTripState()) =>
  applyIntakeUpdate(state, { ...blankUpdate, ...update }, today);

afterEach(() => setIntakeFetchForTest(null));

describe("phases", () => {
  it("walks dates, city, plans, budget, complete", () => {
    let state = emptyTripState();
    expect(intakePhase(state)).toBe("dates");
    state = { ...state, start_date: "2026-11-10", end_date: "2026-11-12" };
    expect(intakePhase(state)).toBe("city");
    state = { ...state, city: "Paris" };
    expect(intakePhase(state)).toBe("plans");
    state = { ...state, plans: "a museum", needs_search: true };
    expect(intakePhase(state)).toBe("budget");
    state = { ...state, budget_answered: true };
    expect(intakePhase(state)).toBe("complete");
    expect(missingFields(state)).toEqual([]);
    expect(nextQuestion(state)).toBeNull();
  });

  it("asks only for the missing end", () => {
    const state = { ...emptyTripState(), start_date: "2026-11-10" };
    expect(missingFields(state)).toContain("end_date");
    expect(missingFields(state)).not.toContain("start_date");
    expect(nextQuestion(state)).toMatch(/end/);
  });

  it("a null budget is not an answer unless budget_answered is set", () => {
    expect(missingFields({ ...filled, budget_answered: false })).toEqual(["budget"]);
    expect(missingFields({ ...filled, budget_answered: true, budget_usd: null })).toEqual([]);
  });

  it("does not trust a state with bad values", () => {
    expect(missingFields({ ...filled, start_date: "soon" })).toContain("start_date");
    expect(missingFields({ ...filled, end_date: "2026-11-09" })).toContain("end_date");
    expect(
      missingFields({ ...filled, start_date: "2026-11-01", end_date: "2026-11-02" }, today),
    ).toEqual(["start_date", "end_date"]);
    expect(missingFields({ ...filled, plans: "  " })).toContain("plans");
    expect(missingFields({ ...filled, named_places: [], needs_search: false })).toContain("plans");
  });
});

describe("applyIntakeUpdate", () => {
  it("null leaves fields as they are; new values overwrite", () => {
    expect(apply({}, filled).state).toEqual(filled);
    expect(apply({ city: "Rome" }, filled).state.city).toBe("Rome");
  });

  it("rejects non-dates and impossible dates", () => {
    const { state, problems } = apply({ start_date: "next week", end_date: "2026-02-30" });
    expect(state.start_date).toBeNull();
    expect(state.end_date).toBeNull();
    expect(problems).toHaveLength(2);
  });

  it("rejects past dates, but accepts today", () => {
    expect(apply({ start_date: "2026-11-04" }).state.start_date).toBeNull();
    expect(apply({ start_date: today }).state.start_date).toBe(today);
  });

  it("rejects an end before the start and keeps the start", () => {
    const { state, problems } = apply({ start_date: "2026-11-10", end_date: "2026-11-09" });
    expect(state.start_date).toBe("2026-11-10");
    expect(state.end_date).toBeNull();
    expect(problems[0]).toMatch(/before/);
  });

  it("accepts a one-day trip", () => {
    const { state } = apply({ start_date: "2026-11-10", end_date: "2026-11-10" });
    expect(missingFields(state).includes("end_date")).toBe(false);
  });

  it("'no limit' is answered with null", () => {
    const { state } = apply({ budget_answered: true, budget_amount: null });
    expect(state.budget_answered).toBe(true);
    expect(state.budget_usd).toBeNull();
  });

  it("converts known currencies with FX_TO_USD and treats no currency as USD", () => {
    expect(
      apply({ budget_answered: true, budget_amount: 100, budget_currency: "eur" }).state.budget_usd,
    ).toBe(108);
    expect(apply({ budget_answered: true, budget_amount: 100 }).state.budget_usd).toBe(100);
  });

  it("asks again for an unknown currency instead of guessing", () => {
    const { state, problems } = apply({
      budget_answered: true,
      budget_amount: 100,
      budget_currency: "XXX",
    });
    expect(state.budget_answered).toBe(false);
    expect(problems[0]).toContain("XXX");
    expect(nextQuestion({ ...filled, budget_answered: false })).toMatch(/budget/);
  });

  it("rejects a negative budget", () => {
    expect(apply({ budget_answered: true, budget_amount: -5 }).state.budget_answered).toBe(false);
  });

  it("forces a search when plans name no place, whatever the model said", () => {
    expect(apply({ plans: "something nice", needs_search: false }).state.needs_search).toBe(true);
    expect(
      apply({
        plans: "Louvre",
        named_places: [{ name: "Louvre", note: null }],
        needs_search: false,
      }).state.needs_search,
    ).toBe(false);
  });
});

const reply = (update: Partial<IntakeUpdate>, overrides: Record<string, unknown> = {}) =>
  message({
    content: [{ type: "text", text: JSON.stringify({ ...blankUpdate, ...update }) }],
    ...overrides,
  });

const turn = (state: TripState = emptyTripState(), userMessage = "hi") =>
  advanceIntake({ state, messages: [], userMessage, today });

describe("advanceIntake over LangChain", () => {
  it("wire request: effort, json schema format, no tools or forbidden params", async () => {
    const { fetchFn, requests } = fakeFetch([reply({})]);
    setIntakeFetchForTest(fetchFn);
    await advanceIntake({
      state: emptyTripState(),
      messages: [
        { id: "1", role: "user", content: "hello", createdAt: "" },
        { id: "2", role: "assistant", content: "When?", createdAt: "" },
      ],
      userMessage: "soon",
      today,
    });
    const { body, url, headers } = requests[0]!;
    expect(url).toContain("/v1/messages");
    expect(body.model).toBe(CLAUDE_MODEL);
    expect(body.output_config.effort).toBe(INTAKE_EFFORT);
    expect(body.output_config.format.type).toBe("json_schema");
    for (const key of ["temperature", "top_p", "top_k", "thinking", "tool_choice", "tools"]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(headers.get("anthropic-beta")).toBeNull();
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(body.messages.at(-1).content).toBe("soon");
    expect(body.system).toContain(today);
  });

  it("does not repeat the message when the route already stored it", async () => {
    const { fetchFn, requests } = fakeFetch([reply({})]);
    setIntakeFetchForTest(fetchFn);
    await advanceIntake({
      state: emptyTripState(),
      messages: [{ id: "1", role: "user", content: "soon", createdAt: "" }],
      userMessage: "soon",
      today,
    });
    expect(requests[0]!.body.messages).toHaveLength(1);
  });

  it("code decides the reply and completion", async () => {
    const { fetchFn } = fakeFetch([reply({ city: "Paris", acknowledgement: "Lovely." })]);
    setIntakeFetchForTest(fetchFn);
    const result = await turn();
    expect(result.complete).toBe(false);
    expect(result.reply).toMatch(/^Lovely\. /);
    expect(result.reply).toMatch(/When do you want to travel/);
    expect(result.state.city).toBe("Paris");
  });

  it("the model cannot complete a trip with invalid fields", async () => {
    const { fetchFn } = fakeFetch([
      reply({
        start_date: "2020-01-01",
        end_date: "2020-01-02",
        city: "Paris",
        plans: "x",
        needs_search: true,
        budget_answered: true,
      }),
    ]);
    setIntakeFetchForTest(fetchFn);
    const result = await turn();
    expect(result.complete).toBe(false);
    expect(result.reply).toMatch(/in the past/);
    expect(result.state.start_date).toBeNull();
  });

  it("completes when code sees everything", async () => {
    const { fetchFn } = fakeFetch([reply({ budget_answered: true, budget_amount: null })]);
    setIntakeFetchForTest(fetchFn);
    const result = await turn({ ...filled, budget_answered: false });
    expect(result.complete).toBe(true);
    expect(result.reply).toMatch(/no budget limit/);
  });

  it("maps refusal, cut-off, bad output and API errors", async () => {
    const cases: [unknown, string][] = [
      [message({ stop_reason: "refusal", content: [{ type: "text", text: "no" }] }), "refusal"],
      [
        message({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"acknow' }] }),
        "max_tokens",
      ],
      [message({ content: [{ type: "text", text: "not json" }] }), "extract_failed"],
      [
        jsonResponse(
          { type: "error", error: { type: "invalid_request_error", message: "bad" } },
          400,
        ),
        "api",
      ],
    ];
    for (const [fakeReply, code] of cases) {
      const { fetchFn } = fakeFetch([fakeReply as Response]);
      setIntakeFetchForTest(fetchFn);
      await expect(turn()).rejects.toMatchObject({ code });
    }
  });
});
