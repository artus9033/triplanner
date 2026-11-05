import { spawn } from "node:child_process";

export type RunResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export type RunOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  input?: string;
  /** Stream output to the terminal instead of capturing it. */
  inherit?: boolean;
};

/** Runs a command and reports the outcome. Never rejects, including when the binary is absent. */
export const run = (cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      timeout: options.timeoutMs,
      stdio: [
        options.input === undefined ? "ignore" : "pipe",
        options.inherit ? "inherit" : "pipe",
        options.inherit ? "inherit" : "pipe",
      ],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ ok: false, code: null, stdout, stderr, error: e.message }));
    child.on("close", (code, signal) =>
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
        ...(signal ? { error: `stopped by ${signal}` } : {}),
      }),
    );
    if (options.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.input);
    }
  });

export const lastLine = (text: string): string => text.trim().split("\n").pop()?.trim() ?? "";
