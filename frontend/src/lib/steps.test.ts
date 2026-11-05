import { describe, expect, it } from "vitest";
import { makeState, makeTrip } from "../test/fixtures";
import { canViewStep, refinementSkipped, resolveView, stepState } from "./steps";

describe("steps", () => {
  it("marks step 1 skipped only when no search was needed and the trip moved past it", () => {
    const skipped = makeTrip({ step: "place_data", state: makeState({ needs_search: false }) });
    expect(refinementSkipped(skipped)).toBe(true);
    expect(stepState(skipped, "refinement")).toBe("skipped");

    expect(refinementSkipped(makeTrip({ step: "intake" }))).toBe(false);
    expect(refinementSkipped(makeTrip({ step: "refinement" }))).toBe(false);
    const searched = makeTrip({
      step: "review",
      state: makeState({ needs_search: true }),
      proposals: { status: "ready", items: [], error: null },
    });
    expect(stepState(searched, "refinement")).toBe("complete");
  });

  it("cannot jump ahead or return to a confirmed proposal list", () => {
    const trip = makeTrip({ step: "review", state: makeState({ needs_search: true }) });
    expect(canViewStep(trip, "final")).toBe(false);
    expect(canViewStep(trip, "refinement")).toBe(false);
    expect(canViewStep(trip, "intake")).toBe(true);
    expect(resolveView(trip, "final")).toBe("review");
    expect(resolveView(trip, "intake")).toBe("intake");
    expect(resolveView(trip, null)).toBe("review");
  });
});
