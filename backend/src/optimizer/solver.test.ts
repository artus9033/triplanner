import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { amplStatus, clearOptimizerCache, optimizeInstance } from "./index";
import { at, makeInstance } from "./testFixtures";
import { resolveAmpl } from "./runSolver";
import { parsePasses, parseSolution } from "./parseSolution";
import { validateSchedule } from "./validate";

const { available } = await amplStatus();

const dir = mkdtempSync(path.join(tmpdir(), "triplanner-fake-ampl-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fakeAmpl = (name: string, body: string): string => {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};

const small = (id: string) => makeInstance({ places: [{ id }], tauDefault: 5 });

describe("solver failures degrade to the fallback", () => {
  it("handles a missing binary", async () => {
    const outcome = await optimizeInstance(small("missing"), { amplBin: path.join(dir, "nope") });
    expect(outcome.status).toBe("fallback");
    expect(outcome.result?.quality).toBe("heuristic");
    expect(outcome.result?.diagnostics.fallbackReason).toMatch(/could not start/);
    expect(outcome.result?.items).toHaveLength(1);
  });

  it("handles amplBin: null", async () => {
    const outcome = await optimizeInstance(small("null"), { amplBin: null });
    expect(outcome.status).toBe("fallback");
    expect(outcome.result?.diagnostics.fallbackReason).toMatch(/disabled/);
  });

  it("kills a hanging binary at the limit", async () => {
    const hang = fakeAmpl("hang", "sleep 30");
    const started = Date.now();
    const outcome = await optimizeInstance(small("hang"), { amplBin: hang, timeLimitMs: 300 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(outcome.status).toBe("fallback");
    expect(outcome.result?.diagnostics.fallbackReason).toMatch(/killed at the time limit/);
  });

  it("handles a binary that prints garbage and exits 0", async () => {
    const garbage = fakeAmpl("garbage", 'echo "%%% not a solution %%%"; echo BEGIN > solution.csv');
    const outcome = await optimizeInstance(small("garbage"), { amplBin: garbage });
    expect(outcome.status).toBe("fallback");
    expect(outcome.result?.diagnostics.fallbackReason).toMatch(/without writing a usable solution/);
  });

  it("handles a binary that exits with an error", async () => {
    const broken = fakeAmpl("broken", 'echo "boom" >&2; exit 7');
    const outcome = await optimizeInstance(small("broken"), { amplBin: broken });
    expect(outcome.status).toBe("fallback");
    expect(outcome.result?.diagnostics.fallbackReason).toMatch(/code 7.*boom/);
  });

  it("rejects a well-formed but impossible solution", async () => {
    // Start 0 is fine for the parser. Listing a place on a day it has no window is not fine for assembly.
    const instance = makeInstance({
      days: 2,
      places: [{ id: "A", windows: [{ day: 1, open: at(1, 9), close: at(1, 20) }] }],
    });
    const liar = fakeAmpl("liar", 'printf "BEGIN,coverage\\nV,p0,2,0,0\\nEND\\n" > solution.csv');
    const outcome = await optimizeInstance(instance, { amplBin: liar });
    expect(outcome.status).toBe("fallback");
    expect(outcome.result?.diagnostics.fallbackReason).toMatch(/failed validation/);
    expect(outcome.result?.items[0]?.day).toBe(1);
  });

  it("does not cache a fallback outcome", async () => {
    clearOptimizerCache();
    const instance = small("nocache");
    const first = await optimizeInstance(instance, { amplBin: null });
    expect(first.status).toBe("fallback");
    if (available) {
      const second = await optimizeInstance(instance);
      expect(second.status).toBe("solved");
      expect(second.result?.quality).toBe("optimal");
    }
  });
});

describe("parseSolution", () => {
  const symbols = new Map([
    ["p0", "A"],
    ["p1", "B"],
  ]);

  it("ignores a section cut off by a kill, keeping the last complete one", () => {
    const csv = "BEGIN,coverage\nV,p0,1,600,0\nT,p0,paid\nEND\nBEGIN,compactness\nV,p1,1,";
    const parsed = parseSolution(csv, symbols);
    expect(parsed?.source).toBe("coverage");
    expect(parsed?.plans.get(1)).toEqual([{ placeId: "A", shortened: false, ticketKind: "paid" }]);
    expect(parsed?.lateStarts).toBeUndefined();
  });

  it("orders a day by start time and reads the late section", () => {
    const csv =
      "BEGIN,compactness\nV,p0,1,700,1\nV,p1,1,600,0\nEND\nBEGIN,late\nL,p0,710.000001\nL,p1,600\nEND\n";
    const parsed = parseSolution(csv, symbols);
    expect(parsed?.source).toBe("compactness");
    expect(parsed?.plans.get(1)?.map((visit) => [visit.placeId, visit.shortened])).toEqual([
      ["B", false],
      ["A", true],
    ]);
    expect(parsed?.lateStarts?.get("A")).toBeCloseTo(710, 3);
  });

  it("returns null for garbage and for unknown symbols", () => {
    expect(parseSolution("", symbols)).toBeNull();
    expect(parseSolution("no sections at all\n", symbols)).toBeNull();
    expect(parseSolution("BEGIN,x\nV,p9,1,600,0\nEND\n", symbols)).toBeNull();
  });

  it("reads pass lines", () => {
    const passes = parsePasses(
      "PASS,coverage,solved,0,216.03,0,0.28,1\nPASS,compactness,limit,472,0,0,1.2,0\njunk\n",
    );
    expect(passes).toEqual([
      { name: "coverage", objective: 216.03, status: "solved (0)", gap: 0, wallMs: 280 },
      { name: "compactness", objective: null, status: "limit (472)", gap: null, wallMs: 1200 },
    ]);
  });
});

/** The design's own sizing: an all-open instance, the hardest kind for this model. */
const sized = (count: number, days: number) => {
  const ids = Array.from({ length: count }, (_, index) => `P${index}`);
  const tau: Record<string, number> = {};
  ids.forEach((a, i) => {
    tau[`S>${a}`] = 5 + (i % 7) * 3;
    tau[`${a}>E`] = 5 + (i % 5) * 3;
    ids.forEach((b, j) => {
      if (a !== b) tau[`${a}>${b}`] = 3 + ((i * 7 + j * 11) % 23);
    });
  });
  return makeInstance({
    days,
    places: ids.map((id, index) => ({
      id,
      dur: 60,
      u: index < 2 ? 100 : 10 / (index + 1),
      must: index < 2,
    })),
    tau,
  });
};

describe.skipIf(!available)("real AMPL", () => {
  it("is found and reports itself for /api/health", async () => {
    expect(resolveAmpl()).toMatch(/ampl$/);
    const status = await amplStatus();
    expect(status.available).toBe(true);
    expect(status.detail).toMatch(/AMPL Version/);
  });

  it("degrades to the fallback at the demo size limit, 40 places x 14 days", async () => {
    const instance = sized(40, 14);
    const started = Date.now();
    const outcome = await optimizeInstance(instance, { timeLimitMs: 5000 });
    expect(Date.now() - started).toBeLessThan(5500);
    if (outcome.status === "fallback") {
      expect(outcome.result?.diagnostics.fallbackReason).toMatch(/licence size limit/);
    }
    expect(outcome.result).not.toBeNull();
    expect(validateSchedule(instance, outcome.result as never)).toEqual([]);
  });

  it("reports a time-limit incumbent as good, 12 places x 4 days", async () => {
    const instance = sized(12, 4);
    const outcome = await optimizeInstance(instance, { timeLimitMs: 2000 });
    expect(outcome.status).toBe("solved");
    expect(outcome.result?.diagnostics.fallbackReason).toBeNull();
    expect(outcome.result?.quality).toBe("good");
    expect(outcome.result?.diagnostics.passes.some((p) => p.status.startsWith("limit"))).toBe(true);
    expect(outcome.result?.items.length).toBe(12);
    expect(validateSchedule(instance, outcome.result as never)).toEqual([]);
  });
});
