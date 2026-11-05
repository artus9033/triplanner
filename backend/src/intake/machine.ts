import { generateText, jsonSchema, Output, type JSONSchema7 } from "ai";
import { NamedPlaceSchema, type ChatMessage, type TripState } from "@triplanner/shared";
import { z } from "zod";
import { INTAKE_EFFORT, INTAKE_MAX_TOKENS } from "../config/llm";
import { FX_TO_USD } from "../config/optimizer";
import { llmModel, effortOptions } from "../llm/client";
import { LlmError, structuredOutputError } from "../llm/errors";
import { isIsoDate, weekdayOf } from "../llm/validate";

export type IntakeField = "start_date" | "end_date" | "city" | "plans" | "budget";
export type IntakePhase = "dates" | "city" | "plans" | "budget" | "complete";

const hasText = (value: string | null): boolean => !!value?.trim();

/**
 * Which fields still block completion. This is the only completion check: the model never decides.
 * With `today`, dates in the past count as missing too.
 */
export const missingFields = (state: TripState, today?: string): IntakeField[] => {
  const missing: IntakeField[] = [];
  const startOk = isIsoDate(state.start_date) && (!today || state.start_date >= today);
  if (!startOk) missing.push("start_date");
  const endOk =
    isIsoDate(state.end_date) &&
    (!today || state.end_date >= today) &&
    (!startOk || (state.end_date as string) >= (state.start_date as string));
  if (!endOk) missing.push("end_date");
  if (!hasText(state.city)) missing.push("city");
  // Plans that name no place and need no search would leave nothing to visit.
  if (!hasText(state.plans) || (state.named_places.length === 0 && !state.needs_search)) {
    missing.push("plans");
  }
  if (!state.budget_answered) missing.push("budget");
  return missing;
};

export const intakePhase = (state: TripState, today?: string): IntakePhase => {
  const missing = missingFields(state, today);
  if (missing.includes("start_date") || missing.includes("end_date")) return "dates";
  if (missing.includes("city")) return "city";
  if (missing.includes("plans")) return "plans";
  if (missing.includes("budget")) return "budget";
  return "complete";
};

/** The question for the current phase, or null once intake is complete. */
export const nextQuestion = (state: TripState, today?: string): string | null => {
  const missing = missingFields(state, today);
  switch (intakePhase(state, today)) {
    case "dates":
      if (missing.includes("start_date") && !missing.includes("end_date")) {
        return "What day does your trip start?";
      }
      return missing.includes("start_date")
        ? "When do you want to travel? Please give me your start and end dates."
        : "What day does your trip end?";
    case "city":
      return "Which city are you going to?";
    case "plans":
      return "What would you like to do there? It can be specific places or just the kind of things you enjoy.";
    case "budget":
      return "What budget do you have in US dollars? If you have no limit, just say so.";
    case "complete":
      return null;
  }
};

const completionMessage = (state: TripState): string => {
  const budget = state.budget_usd === null ? "no budget limit" : `a budget of $${state.budget_usd}`;
  const next = state.needs_search
    ? "Next I'll look for places that match your plans."
    : "Next I'll look up the places you named.";
  return `That's everything I need: ${state.city}, ${state.start_date} to ${state.end_date}, with ${budget}. ${next}`;
};

/** What the model fills in on each turn. null means the user did not state or change that field. */
export const IntakeUpdateSchema = z.object({
  acknowledgement: z
    .string()
    .describe("One short, warm sentence responding to the message. Never a question."),
  start_date: z.string().nullable().describe("YYYY-MM-DD"),
  end_date: z.string().nullable().describe("YYYY-MM-DD"),
  city: z.string().nullable(),
  plans: z
    .string()
    .nullable()
    .describe("All wishes so far, in the user's words. null if they stated none."),
  named_places: z
    .array(NamedPlaceSchema)
    .nullable()
    .describe("Every specific, identifiable place named so far, with the user's details as note."),
  needs_search: z
    .boolean()
    .nullable()
    .describe("True if any wish is not a specific place, e.g. 'a museum', 'modern art galleries'."),
  budget_answered: z
    .boolean()
    .describe("True if the user stated a budget or said they have no limit, now or earlier."),
  budget_amount: z.number().nullable().describe("null when the user has no limit"),
  budget_currency: z.string().nullable().describe("ISO 4217 code, e.g. USD, as stated by the user"),
});
export type IntakeUpdate = z.infer<typeof IntakeUpdateSchema>;

/**
 * Merges a model update into the state, with every check in code. Invalid values are dropped and
 * explained, which puts the field back on the list of questions. Pure.
 */
export const applyIntakeUpdate = (
  state: TripState,
  update: IntakeUpdate,
  today: string,
): { state: TripState; problems: string[] } => {
  const next: TripState = { ...state };
  const problems: string[] = [];

  next.city = update.city?.trim() || next.city;
  next.plans = update.plans?.trim() || next.plans;
  next.named_places = update.named_places ?? next.named_places;
  next.needs_search = update.needs_search ?? next.needs_search;
  // Named places are plans, even when the model reports them only in named_places.
  if (!hasText(next.plans) && next.named_places.length > 0) {
    next.plans = next.named_places.map((place) => place.name).join(", ");
  }
  // With wishes but no named place, the only way forward is a search.
  if (hasText(next.plans) && next.named_places.length === 0) next.needs_search = true;

  next.start_date = update.start_date ?? next.start_date;
  next.end_date = update.end_date ?? next.end_date;
  for (const field of ["start_date", "end_date"] as const) {
    const value = next[field];
    if (value === null) continue;
    if (!isIsoDate(value)) {
      problems.push(`I couldn't read "${value}" as a date.`);
      next[field] = null;
    } else if (value < today) {
      problems.push(`${value} is in the past (today is ${today}).`);
      next[field] = null;
    }
  }
  if (next.start_date && next.end_date && next.end_date < next.start_date) {
    problems.push(`The end date ${next.end_date} is before the start date ${next.start_date}.`);
    next.end_date = null;
  }

  if (update.budget_answered) {
    const currency = (update.budget_currency ?? "USD").trim().toUpperCase();
    const rate = FX_TO_USD[currency];
    if (update.budget_amount === null) {
      next.budget_answered = true;
      next.budget_usd = null;
    } else if (rate === undefined) {
      problems.push(`I can't convert ${currency} to US dollars.`);
      next.budget_answered = false;
      next.budget_usd = null;
    } else if (!Number.isFinite(update.budget_amount) || update.budget_amount < 0) {
      problems.push("A budget can't be negative.");
      next.budget_answered = false;
      next.budget_usd = null;
    } else {
      next.budget_answered = true;
      next.budget_usd = Math.round(update.budget_amount * rate * 100) / 100;
    }
  }
  return { state: next, problems };
};

const systemPrompt = (state: TripState, today: string): string =>
  `You help a traveller set up a trip by reading their chat messages and filling in a form. The app asks the questions; you only record what they said.

Today is ${today} (${weekdayOf(today)}). Resolve relative dates against it and give dates as YYYY-MM-DD.

Current form:
${JSON.stringify(state)}

Read the whole of the latest message, which often answers several things at once, and record every one of them. Use null only for what the user has not stated.

Plans: a specific place goes in named_places, with any details they gave as its note. For "the Louvre, Richelieu wing, and some modern art galleries", name the Louvre with note "Richelieu wing", and set needs_search to true because the galleries are unspecific. needs_search is false only if every wish is a specific place.

Budget: "no limit" or similar means budget_answered is true with a null amount. Report the amount and currency as the user gave them, without converting.`;

/** Code asks the questions. A question the model added anyway would be a second one in the reply. */
export const statementsOnly = (text: string): string =>
  (text.match(/[^.!?]+[.!?]*\s*/g) ?? [])
    .filter((sentence) => !sentence.trim().endsWith("?"))
    .join("")
    .trim();

export type IntakeTurn = {
  state: TripState;
  messages: ChatMessage[];
  userMessage: string;
  /** YYYY-MM-DD */
  today: string;
  signal?: AbortSignal;
};

/** One turn of the step 0 chat. The model fills in fields; code decides what happens next. */
export const advanceIntake = async ({
  state,
  messages,
  userMessage,
  today,
  signal,
}: IntakeTurn): Promise<{ state: TripState; reply: string; complete: boolean }> => {
  // The route may already have stored the new message in the history.
  const last = messages.at(-1);
  const history =
    last?.role === "user" && last.content === userMessage ? messages.slice(0, -1) : messages;

  let update: IntakeUpdate;
  try {
    const result = await generateText({
      model: llmModel(),
      system: systemPrompt(state, today),
      messages: [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: userMessage },
      ],
      output: Output.object({
        schema: jsonSchema(z.toJSONSchema(IntakeUpdateSchema) as JSONSchema7),
      }),
      maxOutputTokens: INTAKE_MAX_TOKENS,
      abortSignal: signal,
      providerOptions: effortOptions(INTAKE_EFFORT),
    });
    if (result.finishReason === "content-filter") throw new LlmError("refusal");
    if (result.finishReason === "length") throw new LlmError("max_tokens");
    update = IntakeUpdateSchema.parse(result.output);
  } catch (err) {
    throw structuredOutputError(err, signal);
  }

  const { state: nextState, problems } = applyIntakeUpdate(state, update, today);
  const complete = missingFields(nextState, today).length === 0;
  const parts = [
    statementsOnly(update.acknowledgement),
    ...problems,
    complete ? completionMessage(nextState) : nextQuestion(nextState, today),
  ];
  return { state: nextState, reply: parts.filter(Boolean).join(" "), complete };
};
