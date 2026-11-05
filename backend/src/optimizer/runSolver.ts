import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolsDir } from "../config/env";

const ASSETS = ["trip.mod", "trip.run", "snapshot.run", "late.run", "record_pass.run"];
const assetPath = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

const isExecutable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** AMPL modules live in <venv>/lib/python<x>/site-packages/ampl_module_<name>/bin. */
const venvModuleRoots = (): string[] => {
  const lib = path.join(toolsDir(), "ampl-venv", "lib");
  return listDir(lib)
    .filter((entry) => entry.startsWith("python"))
    .sort()
    .map((entry) => path.join(lib, entry, "site-packages"));
};

/** AMPL_BIN, then PATH, then the venv under toolsDir(). Null when there is none. */
export const resolveAmpl = (): string | null => {
  const configured = process.env.AMPL_BIN?.trim();
  if (configured) return isExecutable(configured) ? configured : null;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && isExecutable(path.join(dir, "ampl"))) return path.join(dir, "ampl");
  }
  for (const root of venvModuleRoots()) {
    const candidate = path.join(root, "ampl_module_base", "bin", "ampl");
    if (isExecutable(candidate)) return candidate;
  }
  return null;
};

/** ampl finds its solver on PATH, so the sibling module bin directories go there. */
const childEnv = (amplBin: string, extra: Record<string, string>): NodeJS.ProcessEnv => {
  const binDir = path.dirname(amplBin);
  const dirs = [binDir];
  const moduleRoot = path.dirname(path.dirname(binDir));
  for (const entry of listDir(moduleRoot)) {
    if (entry.startsWith("ampl_module_")) dirs.push(path.join(moduleRoot, entry, "bin"));
  }
  for (const root of venvModuleRoots()) {
    for (const entry of listDir(root)) {
      if (entry.startsWith("ampl_module_")) dirs.push(path.join(root, entry, "bin"));
    }
  }
  return {
    ...process.env,
    ...extra,
    PATH: [...new Set(dirs), process.env.PATH ?? ""].join(path.delimiter),
  };
};

interface SpawnResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  spawnError: string | null;
}

const OUTPUT_CAP = 64_000;
const KILL_GRACE_MS = 300;

/** Runs in its own process group, so a kill at the limit also takes the solver child with it. */
const runProcess = (
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  limitMs: number,
): Promise<SpawnResult> =>
  new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null, spawnError: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ exitCode, timedOut, output, spawnError });
    };
    let grace: NodeJS.Timeout | undefined;
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk: Buffer): void => {
      if (output.length < OUTPUT_CAP) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      // A grandchild holding the pipes must not hold the wall clock too.
      grace = setTimeout(() => finish(null, null), KILL_GRACE_MS);
    }, limitMs);
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code, null));
  });

export interface SolverRun {
  /** Why no solution can be expected, when that is known. */
  failure: string | null;
  timedOut: boolean;
  passesCsv: string;
  solutionCsv: string;
  output: string;
  wallMs: number;
}

const readOr = async (file: string): Promise<string> => {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
};

const describeExit = (result: SpawnResult): string | null => {
  if (result.spawnError) return `AMPL could not start: ${result.spawnError}`;
  if (result.timedOut) return "AMPL was killed at the time limit with no solution written.";
  const licence = /limited to[^\n]*\n?[^\n]*\n?[^.]*\.\s*You have[^.]*\./i.exec(result.output);
  if (licence) {
    return `The AMPL licence size limit was exceeded: ${licence[0].replace(/\s+/g, " ")}`;
  }
  if (result.exitCode === 3) return "The solver hit its time limit with no feasible schedule.";
  if (result.exitCode !== 0) {
    const tail = result.output.trim().split("\n").slice(-3).join(" ").slice(0, 300);
    return `AMPL exited with code ${result.exitCode}: ${tail}`;
  }
  return null;
};

/** Share of the wall clock the script may plan with; the rest covers process and file overhead. */
const SCRIPT_BUDGET_SHARE = 0.85;

/** Runs trip.run in a fresh temp dir, killed at the wall-clock limit. Never throws for AMPL faults. */
export const runSolver = async (
  dat: string,
  amplBin: string,
  timeLimitMs: number,
): Promise<SolverRun> => {
  const started = Date.now();
  const runDir = await mkdtemp(path.join(tmpdir(), "triplanner-opt-"));
  try {
    await Promise.all(ASSETS.map((name) => copyFile(assetPath(name), path.join(runDir, name))));
    await writeFile(path.join(runDir, "trip.dat"), dat);
    const env = childEnv(amplBin, {
      TRIP_TIME_LIMIT_S: ((timeLimitMs * SCRIPT_BUDGET_SHARE) / 1000).toFixed(3),
    });
    const result = await runProcess(amplBin, ["trip.run"], runDir, env, timeLimitMs);
    return {
      failure: describeExit(result),
      timedOut: result.timedOut,
      passesCsv: await readOr(path.join(runDir, "passes.csv")),
      solutionCsv: await readOr(path.join(runDir, "solution.csv")),
      output: result.output,
      wallMs: Date.now() - started,
    };
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
};

const STATUS_LIMIT_MS = 5_000;

/** Solves a one-variable model through the real binaries: finding them is not enough. */
export const checkAmpl = async (): Promise<{ available: boolean; detail: string }> => {
  const amplBin = resolveAmpl();
  if (!amplBin) {
    return { available: false, detail: "AMPL was not found (AMPL_BIN, PATH, tools venv)." };
  }
  const runDir = await mkdtemp(path.join(tmpdir(), "triplanner-opt-"));
  try {
    await writeFile(
      path.join(runDir, "check.run"),
      'var x binary; maximize o: x; option solver highs; solve; printf "RESULT=%s\\n", solve_result;\n',
    );
    const env = childEnv(amplBin, {});
    const solve = await runProcess(amplBin, ["check.run"], runDir, env, STATUS_LIMIT_MS);
    if (solve.spawnError) return { available: false, detail: solve.spawnError };
    if (solve.timedOut) return { available: false, detail: "AMPL did not respond in time." };
    if (!solve.output.includes("RESULT=solved")) {
      return {
        available: false,
        detail: `AMPL could not solve: ${solve.output.trim().slice(0, 300)}`,
      };
    }
    const version = await runProcess(amplBin, ["-v"], runDir, env, STATUS_LIMIT_MS);
    const lines = version.output.split("\n").map((line) => line.trim());
    const about = lines.filter(
      (line) => /^AMPL Version|license/i.test(line) && !/^Using/.test(line),
    );
    return { available: true, detail: [...about, "HiGHS solve ok"].join("; ") };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
};
