export type Level = "ready" | "degraded" | "missing";

export type StatusRow = {
  feature: string;
  status: Level;
  detail: string;
  /** When true, a "missing" status makes check:env exit nonzero. */
  required?: boolean;
};

/** Renders a plain table that stays readable in a log file. */
export const formatTable = (rows: StatusRow[]): string => {
  const header = { feature: "FEATURE", status: "STATUS", detail: "DETAIL" };
  const featureWidth = Math.max(header.feature.length, ...rows.map((r) => r.feature.length));
  const statusWidth = Math.max(header.status.length, ...rows.map((r) => r.status.length));
  const line = (feature: string, status: string, detail: string) =>
    `${feature.padEnd(featureWidth)}  ${status.padEnd(statusWidth)}  ${detail}`.trimEnd();
  return [
    line(header.feature, header.status, header.detail),
    line("-".repeat(featureWidth), "-".repeat(statusWidth), "-".repeat(header.detail.length)),
    ...rows.map((r) => line(r.feature, r.status, r.detail)),
  ].join("\n");
};

/** True when something required is missing, which is what makes check:env fail. */
export const hasRequiredMissing = (rows: StatusRow[]): boolean =>
  rows.some((r) => r.required && r.status === "missing");
