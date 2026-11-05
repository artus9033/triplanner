import { describe, expect, it } from "vitest";
import { formatTable, hasRequiredMissing } from "./table.ts";

describe("formatTable", () => {
  it("aligns columns", () => {
    const lines = formatTable([
      { feature: "Node", status: "ready", detail: "v24" },
      { feature: "MongoDB", status: "degraded", detail: "not running" },
    ]).split("\n");
    expect(lines[0]).toBe("FEATURE  STATUS    DETAIL");
    expect(lines[2]).toBe("Node     ready     v24");
    expect(lines[3]).toBe("MongoDB  degraded  not running");
  });
});

describe("hasRequiredMissing", () => {
  it("fails only on a required row that is missing", () => {
    expect(hasRequiredMissing([{ feature: "a", status: "missing", detail: "" }])).toBe(false);
    expect(
      hasRequiredMissing([{ feature: "a", status: "degraded", detail: "", required: true }]),
    ).toBe(false);
    expect(
      hasRequiredMissing([{ feature: "a", status: "missing", detail: "", required: true }]),
    ).toBe(true);
  });
});
