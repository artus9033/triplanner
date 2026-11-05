import { MAX_BOTS } from "../config/optimizer";

export type BotPoolOptions<T, R> = {
  concurrency?: number;
  onStart?: (item: T, index: number) => void | Promise<void>;
  onDone?: (item: T, result: R, index: number) => void | Promise<void>;
  onError?: (item: T, error: unknown, index: number) => void | Promise<void>;
};

const safely = async (hook: () => void | Promise<void>): Promise<void> => {
  try {
    await hook();
  } catch (err) {
    console.error("[bots] pool hook failed", err);
  }
};

/**
 * Drains `items` with at most `concurrency` workers at once. One failing item, or a throwing hook,
 * never stops the others. Resolves when every item has finished; never rejects.
 */
export const runBotPool = async <T, R = unknown>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  { concurrency = MAX_BOTS, onStart, onDone, onError }: BotPoolOptions<T, R> = {},
): Promise<void> => {
  let next = 0;
  const drain = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      const item = items[index] as T;
      await safely(() => onStart?.(item, index));
      try {
        const result = await worker(item, index);
        await safely(() => onDone?.(item, result, index));
      } catch (err) {
        await safely(() => onError?.(item, err, index));
      }
    }
  };
  const workers = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
  await Promise.all(Array.from({ length: workers }, drain));
};
