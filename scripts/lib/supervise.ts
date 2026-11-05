/** Restart delay after the Nth consecutive quick failure: 1 s, 2 s, 4 s, capped at 15 s. */
export const backoffMs = (failures: number): number =>
  Math.min(15_000, 1_000 * 2 ** Math.max(0, failures - 1));

/** Prefixes complete lines, and holds a partial line until the rest of it arrives. */
export const linePrefixer = (prefix: string, write: (text: string) => void) => {
  let pending = "";
  return {
    push(chunk: string): void {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) write(`${prefix}${line}\n`);
    },
    flush(): void {
      if (pending) write(`${prefix}${pending}\n`);
      pending = "";
    },
  };
};

export const parsePort = (value: string | undefined, fallback: number, name: string): number => {
  const text = value?.trim();
  if (!text) return fallback;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`${name} is not a valid port: ${text}`);
  return port;
};
