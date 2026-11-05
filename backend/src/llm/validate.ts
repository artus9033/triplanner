/** Small pure checks shared by the bots and the intake machine. */

/** Web-derived URLs may only be linked when they are http or https. */
export const httpUrlOrNull = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    const { protocol } = new URL(value.trim());
    return protocol === "http:" || protocol === "https:" ? value.trim() : null;
  } catch {
    return null;
  }
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date in YYYY-MM-DD form (2026-02-30 is not one). */
export const isIsoDate = (value: string | null | undefined): value is string => {
  if (!value || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/** Every date from start to end, inclusive. Empty when the range is invalid. */
export const enumerateDates = (start: string, end: string): string[] => {
  if (!isIsoDate(start) || !isIsoDate(end) || end < start) return [];
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  for (;;) {
    const date = cursor.toISOString().slice(0, 10);
    if (date > end) return dates;
    dates.push(date);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
};

/** "Thursday" for 2026-11-05. Weekdays let the model map weekly opening hours to dates. */
export const weekdayOf = (date: string): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
