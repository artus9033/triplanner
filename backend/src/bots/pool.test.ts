import { describe, expect, it, vi } from "vitest";
import { MAX_BOTS } from "../config/optimizer";
import { runBotPool } from "./pool";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runBotPool", () => {
  it("never exceeds the limit and actually reaches it", async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await runBotPool(
      Array.from({ length: 12 }, (_, i) => i),
      async (item) => {
        active++;
        peak = Math.max(peak, active);
        await sleep(5);
        seen.push(item);
        active--;
      },
      { concurrency: 3 },
    );
    expect(peak).toBe(3);
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it("defaults to MAX_BOTS", async () => {
    let active = 0;
    let peak = 0;
    await runBotPool(Array.from({ length: MAX_BOTS * 3 }), async () => {
      peak = Math.max(peak, ++active);
      await sleep(2);
      active--;
    });
    expect(peak).toBe(MAX_BOTS);
  });

  it("isolates failures and reports each outcome", async () => {
    const onStart = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    const boom = new Error("boom");
    await runBotPool(
      ["a", "bad", "c", "bad2", "e"],
      async (item) => {
        if (item.startsWith("bad")) throw boom;
        return item.toUpperCase();
      },
      { concurrency: 2, onStart, onDone, onError },
    );
    expect(onStart).toHaveBeenCalledTimes(5);
    expect(onDone.mock.calls.map((c) => c[1]).sort()).toEqual(["A", "C", "E"]);
    expect(onError.mock.calls.map((c) => c[0]).sort()).toEqual(["bad", "bad2"]);
    expect(onError.mock.calls[0]?.[1]).toBe(boom);
  });

  it("a throwing hook does not stop the queue", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const worked: number[] = [];
    await runBotPool(
      [1, 2, 3],
      async (item) => {
        worked.push(item);
      },
      {
        concurrency: 1,
        onDone: () => {
          throw new Error("hook");
        },
      },
    );
    expect(worked).toEqual([1, 2, 3]);
    spy.mockRestore();
  });

  it("handles an empty list and a silly concurrency", async () => {
    await expect(runBotPool([], async () => {})).resolves.toBeUndefined();
    const worked: number[] = [];
    await runBotPool([1, 2], async (i) => void worked.push(i), { concurrency: 0 });
    expect(worked).toEqual([1, 2]);
  });
});
