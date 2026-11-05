import { existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { envValue } from "./env-file.ts";
import { lastLine, run } from "./exec.ts";
import type { Level } from "./table.ts";

export const venvDir = (tools: string): string => path.join(tools, "ampl-venv");
const venvPython = (tools: string): string => path.join(venvDir(tools), "bin", "python");

const sitePackages = (tools: string): string[] => {
  const lib = path.join(venvDir(tools), "lib");
  if (!existsSync(lib)) return [];
  return readdirSync(lib)
    .filter((name) => name.startsWith("python"))
    .map((name) => path.join(lib, name, "site-packages"));
};

const moduleBin = (tools: string, module: string, file: string): string | undefined =>
  sitePackages(tools)
    .map((dir) => path.join(dir, module, "bin", file))
    .find((candidate) => existsSync(candidate));

/** The AMPL binary: an explicit AMPL_BIN wins, otherwise the one in the venv. */
export const findAmplBin = (
  tools: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  const explicit = envValue(env, "AMPL_BIN");
  if (explicit) return explicit;
  return moduleBin(tools, "ampl_module_base", "ampl");
};

/**
 * The variables a process needs to run the venv's AMPL: AMPL_BIN, and PATH with the solver's directory
 * so AMPL finds HiGHS. Empty when there is no venv install.
 */
export const amplEnv = (tools: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const bin = findAmplBin(tools, env);
  if (!bin) return {};
  const highs = moduleBin(tools, "ampl_module_highs", "highs");
  const dirs = [path.dirname(bin), ...(highs ? [path.dirname(highs)] : [])];
  return { AMPL_BIN: bin, PATH: [...dirs, env.PATH ?? ""].join(path.delimiter) };
};

const TRIVIAL_MODEL = `
var x >= 0, <= 1;
maximize objective: x;
option solver highs;
solve;
printf "x=%g result=%s\\n", x, solve_result;
`;

/** Solves a one-variable model with the real binary and solver. Uses no licence features. */
export const trivialSolve = async (
  tools: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; detail: string }> => {
  const bin = findAmplBin(tools, env);
  if (!bin) return { ok: false, detail: "AMPL is not installed" };
  const result = await run(bin, [], {
    env: { ...env, ...amplEnv(tools, env) },
    input: TRIVIAL_MODEL,
    timeoutMs: 30_000,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.ok && /x=1 result=solved/.test(output)) {
    return { ok: true, detail: `trivial solve ok with HiGHS (${bin})` };
  }
  return {
    ok: false,
    detail: `trivial solve failed: ${result.error || lastLine(output) || "no output"}`,
  };
};

const findPython = async (env: NodeJS.ProcessEnv): Promise<string | undefined> => {
  for (const candidate of ["python3", "python"]) {
    const result = await run(candidate, ["--version"], { env, timeoutMs: 10_000 });
    if (result.ok && /Python 3\./.test(`${result.stdout}${result.stderr}`)) return candidate;
  }
  return undefined;
};

const installed = async (tools: string, env: NodeJS.ProcessEnv): Promise<boolean> => {
  if (
    !moduleBin(tools, "ampl_module_base", "ampl") ||
    !moduleBin(tools, "ampl_module_highs", "highs")
  )
    return false;
  // A system Python update can leave the venv's interpreter link dangling.
  return (await run(venvPython(tools), ["-c", "import amplpy"], { env, timeoutMs: 30_000 })).ok;
};

/** The licence is activated once per UUID. Only a hash is kept, in a marker inside the venv. */
const activateLicence = async (
  tools: string,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; detail: string }> => {
  const uuid = envValue(env, "AMPLKEY_UUID");
  if (!uuid) return { ok: true, detail: "no AMPLKEY_UUID, using the demo licence" };
  const hash = createHash("sha256").update(uuid).digest("hex").slice(0, 16);
  const marker = path.join(venvDir(tools), `.licence-${hash}`);
  if (existsSync(marker)) return { ok: true, detail: "licence already activated" };
  // Passed through the environment, not argv, because other users of the VM can read process lists.
  // Output is dropped because it may echo the UUID.
  const result = await run(
    venvPython(tools),
    ["-c", "import os; from amplpy import modules; modules.activate(os.environ['AMPLKEY_UUID'])"],
    { env: { ...env, AMPLKEY_UUID: uuid }, timeoutMs: 60_000 },
  );
  if (!result.ok) return { ok: false, detail: "licence activation failed, using the demo licence" };
  writeFileSync(marker, "");
  return { ok: true, detail: "licence activated" };
};

/** Installs AMPL and HiGHS in the venv if needed. Reports problems rather than throwing. */
export const ensureAmpl = async (
  tools: string,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void = () => {},
): Promise<{ level: Level; detail: string }> => {
  if (envValue(env, "AMPL_BIN")) {
    const solve = await trivialSolve(tools, env);
    return { level: solve.ok ? "ready" : "degraded", detail: `AMPL_BIN is set; ${solve.detail}` };
  }

  const degraded = (why: string) => ({
    level: "degraded" as const,
    detail: `${why}; schedules will come from the fallback heuristic`,
  });

  if (await installed(tools, env)) {
    log(`AMPL: found in ${venvDir(tools)}, leaving it alone`);
  } else {
    const python = await findPython(env);
    if (!python) return degraded("python3 not found");
    log(`AMPL: installing into ${venvDir(tools)}`);
    mkdirSync(tools, { recursive: true });
    const steps: [string, string[]][] = [
      [python, ["-m", "venv", "--clear", venvDir(tools)]],
      [
        venvPython(tools),
        ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "amplpy"],
      ],
      [venvPython(tools), ["-m", "amplpy.modules", "install", "highs"]],
    ];
    for (const [cmd, args] of steps) {
      const result = await run(cmd, args, { env, timeoutMs: 600_000 });
      if (!result.ok) {
        const why = result.error || lastLine(result.stderr) || `exit ${result.code}`;
        return degraded(`${path.basename(cmd)} ${args.slice(0, 3).join(" ")} failed: ${why}`);
      }
    }
  }

  const licence = await activateLicence(tools, env);
  const solve = await trivialSolve(tools, env);
  if (!solve.ok) return degraded(solve.detail);
  return { level: licence.ok ? "ready" : "degraded", detail: `${solve.detail}; ${licence.detail}` };
};
