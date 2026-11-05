import type { Diagnostics, TicketKind } from "@triplanner/shared";
import type { DayPlans, PlannedVisit } from "./schedule";

export interface ParsedSolution {
  plans: DayPlans;
  /** Latest starts from pass 3, when it completed. */
  lateStarts: Map<string, number> | undefined;
  /** The name of the pass the plans came from. */
  source: string;
}

const TICKET_KINDS = new Set(["free", "paid", "reduced", "unknown"]);

/** passes.csv: PASS,name,result,code,objective,gap,seconds,ok */
export const parsePasses = (csv: string): Diagnostics["passes"] => {
  const passes: Diagnostics["passes"] = [];
  for (const line of csv.split("\n")) {
    const cols = line.trim().split(",");
    if (cols[0] !== "PASS" || cols.length < 8) continue;
    const number = (value: string | undefined): number | null => {
      const parsed = Number(value);
      return value !== undefined && value !== "" && Number.isFinite(parsed) ? parsed : null;
    };
    const seconds = number(cols[6]);
    const ok = cols[7] === "1";
    passes.push({
      name: cols[1] as string,
      objective: ok ? number(cols[4]) : null,
      status: `${cols[2]} (${cols[3]})`,
      gap: ok ? number(cols[5]) : null,
      wallMs: seconds === null ? null : Math.round(seconds * 1000),
    });
  }
  return passes;
};

/** Did this pass finish with a proven optimum? */
export const passProvedOptimal = (pass: Diagnostics["passes"][number]): boolean =>
  pass.status.startsWith("solved");

interface Section {
  name: string;
  rows: string[][];
}

/** Only sections closed by END count: a kill mid-write must not yield half a solution. */
const readSections = (csv: string): Section[] => {
  const sections: Section[] = [];
  let open: Section | null = null;
  for (const line of csv.split("\n")) {
    const cols = line.trim().split(",");
    if (cols[0] === "BEGIN") open = { name: cols[1] ?? "", rows: [] };
    else if (cols[0] === "END") {
      if (open) sections.push(open);
      open = null;
    } else if (open && cols[0]) open.rows.push(cols);
  }
  return sections;
};

/**
 * solution.csv to day sequences. The order within a day comes from the start times: durations are
 * positive, so times strictly increase along the selected arcs. Returns null when nothing is usable.
 */
export const parseSolution = (
  csv: string,
  symbols: ReadonlyMap<string, string>,
): ParsedSolution | null => {
  const sections = readSections(csv);
  const solution = sections.filter((section) => section.name !== "late").at(-1);
  if (!solution) return null;

  const tickets = new Map<string, TicketKind>();
  for (const row of solution.rows) {
    if (row[0] === "T" && TICKET_KINDS.has(row[2] ?? "")) {
      tickets.set(row[1] as string, row[2] as TicketKind);
    }
  }

  const byDay = new Map<number, { start: number; visit: PlannedVisit }[]>();
  for (const row of solution.rows) {
    if (row[0] !== "V") continue;
    const placeId = symbols.get(row[1] ?? "");
    const day = Number(row[2]);
    const start = Number(row[3]);
    if (placeId === undefined || !Number.isInteger(day) || !Number.isFinite(start)) return null;
    const list = byDay.get(day) ?? [];
    list.push({
      start,
      visit: {
        placeId,
        shortened: row[4] === "1",
        ticketKind: tickets.get(row[1] as string),
      },
    });
    byDay.set(day, list);
  }

  const plans: DayPlans = new Map();
  for (const [day, list] of byDay) {
    plans.set(
      day,
      list.sort((a, b) => a.start - b.start).map((entry) => entry.visit),
    );
  }

  const last = sections.at(-1);
  let lateStarts: Map<string, number> | undefined;
  if (last?.name === "late") {
    lateStarts = new Map();
    for (const row of last.rows) {
      const placeId = symbols.get(row[1] ?? "");
      const value = Number(row[2]);
      if (row[0] !== "L" || placeId === undefined || !Number.isFinite(value)) return null;
      lateStarts.set(placeId, value);
    }
  }
  return { plans, lateStarts, source: solution.name };
};
