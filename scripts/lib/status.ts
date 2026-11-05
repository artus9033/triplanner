import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { findAmplBin, amplEnv, trivialSolve } from "./ampl.ts";
import { apexKeyFrom, envFilePath, envValue } from "./env-file.ts";
import { run } from "./exec.ts";
import { dockerWorks, findMongod, mongoTargetFrom, probeTarget } from "./mongo.ts";
import { REPO_ROOT } from "./paths.ts";
import type { StatusRow } from "./table.ts";

export const tsxBin = (root: string = REPO_ROOT): string =>
  path.join(root, "backend/node_modules/.bin/tsx");
export const dependenciesInstalled = (root: string = REPO_ROOT): boolean =>
  existsSync(tsxBin(root));

/** Compares two "x.y.z" versions. An older major is unusable; the rest only deserves a warning. */
export const compareNode = (
  running: string,
  pinned: string,
): "match" | "newer" | "older-minor" | "wrong-major" => {
  const parse = (v: string) => v.trim().replace(/^v/, "").split(".").map(Number);
  const [ra = 0, rb = 0, rc = 0] = parse(running);
  const [pa = 0, pb = 0, pc = 0] = parse(pinned);
  if (ra !== pa) return "wrong-major";
  if (rb === pb && rc === pc) return "match";
  return rb > pb || (rb === pb && rc > pc) ? "newer" : "older-minor";
};

export const nodeRow = (root: string = REPO_ROOT, running: string = process.version): StatusRow => {
  const pinned = readFileSync(path.join(root, ".nvmrc"), "utf8").trim();
  const result = compareNode(running, pinned);
  const base = { feature: "Node", required: true };
  if (result === "match")
    return { ...base, status: "ready", detail: `${running} (.nvmrc ${pinned})` };
  if (result === "wrong-major") {
    return { ...base, status: "missing", detail: `${running} is running, .nvmrc pins ${pinned}` };
  }
  return { ...base, status: "degraded", detail: `${running} is running, .nvmrc pins ${pinned}` };
};

const pnpmRow = async (root: string, env: NodeJS.ProcessEnv): Promise<StatusRow> => {
  const pinned =
    /pnpm@([\d.]+)/.exec(readFileSync(path.join(root, "package.json"), "utf8"))?.[1] ?? "unknown";
  const result = await run("pnpm", ["--version"], { env, cwd: root, timeoutMs: 30_000 });
  if (!result.ok)
    return {
      feature: "pnpm",
      status: "missing",
      required: true,
      detail: `not found; package.json pins ${pinned}`,
    };
  const version = result.stdout.trim();
  return {
    feature: "pnpm",
    status: version === pinned ? "ready" : "degraded",
    detail: version === pinned ? version : `${version} is running, package.json pins ${pinned}`,
  };
};

const envFileRow = (root: string): StatusRow => {
  const file = envFilePath(root);
  if (!existsSync(file))
    return { feature: ".env", status: "degraded", detail: "absent; run pnpm run bootstrap" };
  const loose = (statSync(file).mode & 0o077) !== 0;
  return loose
    ? {
        feature: ".env",
        status: "degraded",
        detail: "present, but other users can read it; run chmod 600 .env",
      }
    : { feature: ".env", status: "ready", detail: "present, mode 600" };
};

const mongoRow = async (tools: string, env: NodeJS.ProcessEnv): Promise<StatusRow> => {
  const base = { feature: "MongoDB", required: true };
  let target;
  try {
    target = mongoTargetFrom(env);
  } catch (e) {
    return { ...base, status: "missing", detail: (e as Error).message };
  }
  const where = `${target.host}:${target.port}`;
  const probe = await probeTarget(target);
  if (probe === "mongo") return { ...base, status: "ready", detail: `reachable on ${where}` };
  if (probe === "other") {
    return {
      ...base,
      status: "missing",
      detail: `${where} is in use by something that is not MongoDB`,
    };
  }
  if (!target.local) return { ...base, status: "missing", detail: `${where} is not reachable` };
  if (await dockerWorks(env)) {
    return {
      ...base,
      status: "degraded",
      detail: `not running on ${where}; pnpm dev starts it with docker compose`,
    };
  }
  const mongod = await findMongod(tools, env);
  if (mongod)
    return {
      ...base,
      status: "degraded",
      detail: `not running on ${where}; pnpm dev starts ${mongod}`,
    };
  return {
    ...base,
    status: "missing",
    detail: "not running, and no Docker or mongod; run pnpm run bootstrap",
  };
};

const amplRow = async (tools: string, env: NodeJS.ProcessEnv): Promise<StatusRow> => {
  if (!findAmplBin(tools, env)) {
    return {
      feature: "AMPL",
      status: "degraded",
      detail: "not installed; schedules come from the fallback heuristic",
    };
  }
  const solve = await trivialSolve(tools, env);
  return solve.ok
    ? { feature: "AMPL", status: "ready", detail: solve.detail }
    : {
        feature: "AMPL",
        status: "degraded",
        detail: `${solve.detail}; schedules come from the fallback heuristic`,
      };
};

const ffmpegRow = async (env: NodeJS.ProcessEnv): Promise<StatusRow> =>
  (await run("ffmpeg", ["-version"], { env, timeoutMs: 10_000 })).ok
    ? { feature: "ffmpeg", status: "ready", detail: "non-WAV audio uploads can be transcribed" }
    : {
        feature: "ffmpeg",
        status: "degraded",
        detail: "not found; only WAV uploads can be transcribed (recordings still work)",
      };

const dockerRow = async (env: NodeJS.ProcessEnv): Promise<StatusRow> =>
  (await dockerWorks(env))
    ? {
        feature: "Docker",
        status: "ready",
        detail: "working; used for MongoDB when nothing is already running",
      }
    : {
        feature: "Docker",
        status: "degraded",
        detail: "not available; not needed, mongod runs directly",
      };

const CHECK_MARKER = "__CHECK_ENV__";

/** Rows only the backend can produce: the key against the Models API, the optimizer, speech models. */
const backendRows = async (
  root: string,
  tools: string,
  env: NodeJS.ProcessEnv,
): Promise<StatusRow[]> => {
  const result = await run(tsxBin(root), ["src/checkEnv.ts"], {
    cwd: path.join(root, "backend"),
    env: { ...env, TOOLS_DIR: tools, ...amplEnv(tools, env) },
    timeoutMs: 120_000,
  });
  const line = result.stdout.split("\n").find((l) => l.startsWith(CHECK_MARKER));
  if (line) return JSON.parse(line.slice(CHECK_MARKER.length)) as StatusRow[];
  return [
    {
      feature: "Backend checks",
      status: "degraded",
      detail: `could not run backend/src/checkEnv.ts (${result.error ?? `exit ${result.code}`})`,
    },
    keyPresenceRow(env),
  ];
};

const keyPresenceRow = (env: NodeJS.ProcessEnv): StatusRow =>
  apexKeyFrom(env)
    ? {
        feature: "Apex API key",
        status: "degraded",
        required: true,
        detail: "set, but not verified",
      }
    : {
        feature: "Apex API key",
        status: "missing",
        required: true,
        detail: "APEX_API_KEY is not set in .env",
      };

const accessRow = (env: NodeJS.ProcessEnv): StatusRow =>
  envValue(env, "DEV_ACCESS_PASSWORD")
    ? { feature: "Access gate", status: "ready", detail: "DEV_ACCESS_PASSWORD is set" }
    : {
        feature: "Access gate",
        status: "degraded",
        detail: "DEV_ACCESS_PASSWORD not set; fine on 127.0.0.1, required before any tunnel",
      };

/** The status table shared by bootstrap and check:env. Never includes a secret's value. */
export const collectStatus = async (
  tools: string,
  env: NodeJS.ProcessEnv,
  root: string = REPO_ROOT,
): Promise<StatusRow[]> => {
  const installed = dependenciesInstalled(root);
  const [pnpm, mongo, ampl, ffmpeg, docker, backend] = await Promise.all([
    pnpmRow(root, env),
    mongoRow(tools, env),
    amplRow(tools, env),
    ffmpegRow(env),
    dockerRow(env),
    installed
      ? backendRows(root, tools, env)
      : Promise.resolve([
          keyPresenceRow(env),
          {
            feature: "Speech",
            status: "degraded",
            detail: "cannot check until dependencies are installed",
          } satisfies StatusRow,
        ]),
  ]);
  const depsRow: StatusRow = installed
    ? { feature: "Dependencies", status: "ready", required: true, detail: "installed" }
    : {
        feature: "Dependencies",
        status: "missing",
        required: true,
        detail: "not installed; run pnpm run bootstrap",
      };
  return [
    nodeRow(root),
    pnpm,
    depsRow,
    envFileRow(root),
    mongo,
    ampl,
    ...backend,
    ffmpeg,
    docker,
    accessRow(env),
  ];
};
