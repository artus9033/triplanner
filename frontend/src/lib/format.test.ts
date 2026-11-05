import type { PlaceData } from "@triplanner/shared";
import { hoursNote } from "./format";
import { describe, expect, it } from "vitest";
import { addDays, formatDate, formatDuration, formatMoney, formatScheduledTicket } from "./format";

describe("format", () => {
  it("formats calendar dates without shifting them", () => {
    expect(formatDate("2026-05-12")).toBe("Tue 12 May 2026");
    expect(formatDate("not a date")).toBe("not a date");
  });

  it("adds days across a month end", () => {
    expect(addDays("2026-05-31", 1)).toBe("2026-06-01");
  });

  it("formats durations and money", () => {
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(60)).toBe("1 h");
    expect(formatDuration(95)).toBe("1 h 35 min");
    expect(formatMoney(22)).toBe("$22");
    expect(formatMoney(22.5)).toBe("$22.50");
  });

  it("describes each scheduled ticket kind", () => {
    expect(formatScheduledTicket({ kind: "free", price: 0, label: null })).toBe("Free");
    expect(formatScheduledTicket({ kind: "unknown", price: 0, label: null })).toBe(
      "Ticket price unknown",
    );
    expect(formatScheduledTicket({ kind: "reduced", price: 9, label: "Under 25" })).toBe(
      "$9, reduced (Under 25)",
    );
  });
});

describe("hoursNote", () => {
  const data = (over: Partial<PlaceData>) => ({ hours: [], ...over }) as unknown as PlaceData;

  it("separates a confirmed closure, assumed hours, and hours on other dates", () => {
    expect(hoursNote(data({ closed_during_trip: true }))).toBe("Closed on your dates");
    expect(hoursNote(data({}))).toMatch(/assumes 08:00–22:00/);
    const other = data({ hours: [{ date: "2027-01-01", start: "09:00", end: "10:00" }] });
    expect(hoursNote(other)).toBe("None found for your dates");
  });
});
