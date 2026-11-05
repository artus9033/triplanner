import { createHash } from "node:crypto";
import type { TripInstance } from "@triplanner/shared";

export interface WrittenData {
  /** trip.dat. ASCII only: place ids appear as p0, p1, ... */
  dat: string;
  /** Solver symbol to place id. */
  symbols: Map<string, string>;
}

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Fixed notation, so that the same value always prints the same way. */
const num = (value: number): string => {
  const text = value.toFixed(6);
  return text.includes(".") ? text.replace(/\.?0+$/, "") || "0" : text;
};

/** TripInstance to AMPL data. Deterministic: sorted keys and fixed numeric formatting. */
export const writeData = (instance: TripInstance): WrittenData => {
  const places = [...instance.places].sort((a, b) => compareIds(a.id, b.id));
  const symbols = new Map<string, string>();
  const symbolOf = new Map<string, string>([
    ["START", "START"],
    ["END", "END"],
  ]);
  places.forEach((place, index) => {
    symbols.set(`p${index}`, place.id);
    symbolOf.set(place.id, `p${index}`);
  });
  const sym = (id: string): string => symbolOf.get(id) as string;
  const days = [...instance.days].sort((a, b) => a.day - b.day);

  const lines: string[] = [];
  const set = (name: string, members: string[]): void => {
    lines.push(`set ${name} := ${members.join(" ")};`);
  };
  set(
    "P",
    places.map((place) => sym(place.id)),
  );
  set(
    "MUST",
    places.filter((place) => place.must).map((place) => sym(place.id)),
  );
  set(
    "DAYS",
    days.map((day) => String(day.day)),
  );
  set(
    "WIN",
    places.flatMap((place) =>
      [...place.windows]
        .sort((a, b) => a.day - b.day)
        .map((window) => `(${sym(place.id)},${window.day})`),
    ),
  );

  const table = (name: string, rows: string[]): void => {
    if (rows.length > 0) lines.push(`param ${name} :=`, ...rows, ";");
  };
  table(
    "dur",
    places.map((p) => `${sym(p.id)} ${num(p.dur)}`),
  );
  table(
    "delta",
    places.map((p) => `${sym(p.id)} ${num(p.delta)}`),
  );
  table(
    "u",
    places.map((p) => `${sym(p.id)} ${num(p.u)}`),
  );
  const windowRows = (field: "open" | "close"): string[] =>
    places.flatMap((p) =>
      [...p.windows]
        .sort((a, b) => a.day - b.day)
        .map((window) => `${sym(p.id)} ${window.day} ${num(window[field])}`),
    );
  table("openT", windowRows("open"));
  table("closeT", windowRows("close"));

  const tauRows: string[] = [];
  const nodes = ["START", ...places.map((p) => p.id), "END"];
  for (const from of nodes) {
    for (const to of nodes) {
      if (from === to) continue;
      const value = instance.tau[from]?.[to];
      if (value !== undefined) tauRows.push(`${sym(from)} ${sym(to)} ${num(value)}`);
    }
  }
  table("tau", tauRows);

  table(
    "dayStart",
    days.map((day) => `${day.day} ${num(day.dayStart)}`),
  );
  table(
    "dayEnd",
    days.map((day) => `${day.day} ${num(day.dayEnd)}`),
  );
  table(
    "nMax",
    days.map((day) => `${day.day} ${day.nMax}`),
  );

  const tickets = places.flatMap((p) =>
    [...p.tickets]
      .sort((a, b) => compareIds(a.kind, b.kind))
      .map((ticket) => ({ place: sym(p.id), ticket })),
  );
  table(
    "price",
    tickets.map(({ place, ticket }) => `${place} ${ticket.kind} ${num(ticket.price)}`),
  );
  table(
    "elig",
    tickets.flatMap(({ place, ticket }) =>
      [...ticket.eligibleDays]
        .sort((a, b) => a - b)
        .map((day) => `${place} ${ticket.kind} ${day} 1`),
    ),
  );

  // No budget means no line at all: the model default is Infinity and Budget is not generated.
  if (instance.budget !== null) lines.push(`param budget := ${num(instance.budget)};`);
  lines.push(`param Q := ${instance.Q};`);
  lines.push(`param lamTau := ${num(instance.lamTau)};`);
  lines.push(`param lamCost := ${num(instance.lamCost)};`);
  lines.push(`param lamL1 := ${num(instance.lamL1)};`);
  return { dat: `${lines.join("\n")}\n`, symbols };
};

/**
 * sha256 of trip.dat plus what the file leaves out but the outcome depends on (ids, names, dates,
 * labels, presolve results), so two trips never share a cache entry by coincidence.
 */
export const hashInstance = (dat: string, context: unknown): string =>
  createHash("sha256").update(dat).update(JSON.stringify(context)).digest("hex");
