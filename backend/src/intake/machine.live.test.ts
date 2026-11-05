import { emptyTripState, type ChatMessage, type TripState } from "@triplanner/shared";
import { describe, expect, it } from "vitest";
import { apexApiKey } from "../config/env";
import { advanceIntake } from "./machine";

const today = "2026-11-05";
const timeout = 60_000;

const chat = async (lines: string[]) => {
  let state: TripState = emptyTripState();
  const messages: ChatMessage[] = [];
  let reply = "";
  let complete = false;
  for (const line of lines) {
    ({ state, reply, complete } = await advanceIntake({
      state,
      messages,
      userMessage: line,
      today,
    }));
    messages.push(
      { id: String(messages.length), role: "user", content: line, createdAt: "" },
      { id: String(messages.length + 1), role: "assistant", content: reply, createdAt: "" },
    );
  }
  return { state, reply, complete };
};

const trip = "I'm going to Paris from 2026-11-19 to 2026-11-21.";

describe.skipIf(!apexApiKey())("advanceIntake (live)", () => {
  it(
    "a guided multi-turn chat, ending with a 'no limit' budget",
    { timeout: timeout * 2 },
    async () => {
      const first = await chat(["Hi, I want to plan a trip."]);
      expect(first.complete).toBe(false);
      expect(first.state).toEqual(emptyTripState());
      expect(first.reply).toMatch(/when do you want to travel/i);

      const done = await chat([
        "Paris please, from 2026-11-19 to 2026-11-21",
        "I want to visit a museum",
        "no limit",
      ]);
      expect(done.state).toMatchObject({
        start_date: "2026-11-19",
        end_date: "2026-11-21",
        needs_search: true,
        named_places: [],
        budget_answered: true,
        budget_usd: null,
      });
      expect(done.state.city).toMatch(/paris/i);
      expect(done.complete).toBe(true);
    },
  );

  it(
    "the Louvre + galleries example names the Louvre and needs a search",
    { timeout },
    async () => {
      const { state, complete } = await chat([
        `${trip} I want to visit the Louvre, Richelieu wing, and some modern art galleries.`,
      ]);
      expect(complete).toBe(false);
      expect(state.named_places).toHaveLength(1);
      expect(state.named_places[0]?.name).toMatch(/louvre/i);
      expect(state.named_places[0]?.note).toMatch(/richelieu/i);
      expect(state.needs_search).toBe(true);
      expect(state.budget_answered).toBe(false);
    },
  );

  it("specific places only need no search; a stated budget completes it", { timeout }, async () => {
    const { state, complete } = await chat([
      `${trip} I want to visit the Musée d'Orsay and the Eiffel Tower. My budget is $500.`,
    ]);
    expect(state.named_places.map((p) => p.name).join(" ")).toMatch(/orsay.*eiffel/i);
    expect(state.needs_search).toBe(false);
    expect(state.budget_usd).toBe(500);
    expect(complete).toBe(true);
  });

  it("a budget in euros is converted by code", { timeout }, async () => {
    const { state } = await chat([
      `${trip} I'd like to see some museums, with a budget of 1000 euros.`,
    ]);
    expect(state.budget_usd).toBe(1080);
  });

  it("dates in the past do not complete, whatever the model thinks", { timeout }, async () => {
    const { state, complete, reply } = await chat([
      "Paris from 2024-03-01 to 2024-03-03. I want to see the Louvre. No budget limit.",
    ]);
    expect(complete).toBe(false);
    expect(state.start_date).toBeNull();
    expect(reply).toMatch(/past/i);
  });
});
