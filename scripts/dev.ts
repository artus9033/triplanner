import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { amplEnv } from "./lib/ampl.ts";
import { loadRepoEnv } from "./lib/env-file.ts";
import { ensureMongo, type MongoHandle } from "./lib/mongo.ts";
import { isPortOpen } from "./lib/net.ts";
import { REPO_ROOT, resolveToolsDir } from "./lib/paths.ts";
import { dependenciesInstalled } from "./lib/status.ts";
import { backoffMs, linePrefixer, parsePort } from "./lib/supervise.ts";

/*
 * Lifecycle: a mongod or container this run started is stopped on exit, with its data kept. A server
 * that was already running is left running. Children get their own process groups, so a signal reaches
 * them only through this script, in order: the app first, then the database.
 */

const HOST = "127.0.0.1";
/** A process that stayed up this long counts as healthy, which resets the restart backoff. */
const STABLE_MS = 30_000;
const STOP_GRACE_MS = 8_000;
/** `tsx watch` stays alive after the app crashes, so the backend port is watched as well. */
const WATCHDOG_INTERVAL_MS = 5_000;
const WATCHDOG_MISSES = 3;

const log = (message: string) => console.log(`[dev] ${message}`);
const fail = (message: string): never => {
  console.error(`[dev] ${message}`);
  process.exit(1);
};

if (!dependenciesInstalled()) fail("Dependencies are not installed. Run: pnpm run bootstrap");

const env = loadRepoEnv();
const tools = resolveToolsDir(env);
mkdirSync(tools, { recursive: true });

let port = 3000;
let webPort = 5173;
try {
  port = parsePort(env.PORT, port, "PORT");
  webPort = parsePort(env.WEB_PORT, webPort, "WEB_PORT");
} catch (e) {
  fail((e as Error).message);
}
for (const [name, value] of [
  ["PORT", port],
  ["WEB_PORT", webPort],
] as const) {
  if (await isPortOpen(value, HOST)) {
    fail(
      `Port ${value} (${name}) is already in use, and it was left alone. Is the app already running? Otherwise set ${name} to a free port.`,
    );
  }
}

type Service = {
  name: string;
  cwd: string;
  command: string;
  args: string[];
  child: ChildProcess | null;
  failures: number;
  restartTimer: NodeJS.Timeout | null;
};

/*
 * The package binaries run directly, not through pnpm. pnpm can put a script in a process group of its
 * own and does not always forward signals, which would leave a server behind on shutdown or restart.
 * These are the same commands as the packages' `dev` scripts.
 */
const service = (name: string, args: string[], bin: string): Service => {
  const cwd = path.join(REPO_ROOT, name);
  return {
    name,
    cwd,
    command: path.join(cwd, "node_modules/.bin", bin),
    args,
    child: null,
    failures: 0,
    restartTimer: null,
  };
};

const services: Service[] = [
  service("backend", ["watch", "src/main.ts"], "tsx"),
  service("frontend", ["--host", HOST, "--port", String(webPort), "--strictPort"], "vite"),
];

let mongo: MongoHandle | null = null;
let shuttingDown = false;

const childEnv: NodeJS.ProcessEnv = {
  ...env,
  TOOLS_DIR: tools,
  PORT: String(port),
  WEB_PORT: String(webPort),
  ...amplEnv(tools, env),
};

const startService = (service: Service): void => {
  const color = process.stdout.isTTY ? (service.name === "backend" ? "\x1b[36m" : "\x1b[35m") : "";
  const prefix = `${color}[${service.name}]${color ? "\x1b[0m" : ""} `;
  const child = spawn(service.command, service.args, {
    cwd: service.cwd,
    env: childEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  service.child = child;
  const startedAt = Date.now();
  const out = linePrefixer(prefix, (text) => process.stdout.write(text));
  const err = linePrefixer(prefix, (text) => process.stderr.write(text));
  child.stdout.on("data", (d: Buffer) => out.push(d.toString()));
  child.stderr.on("data", (d: Buffer) => err.push(d.toString()));
  child.on("error", (e) => log(`${service.name} could not start: ${e.message}`));
  child.on("close", (code, signal) => {
    out.flush();
    err.flush();
    if (service.child === child) service.child = null;
    if (shuttingDown) return;
    service.failures = Date.now() - startedAt > STABLE_MS ? 1 : service.failures + 1;
    const delay = backoffMs(service.failures);
    log(`${service.name} exited (${signal ?? code}), restarting in ${delay / 1_000} s`);
    service.restartTimer = setTimeout(() => startService(service), delay);
  });
};

const signalGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group has already gone.
  }
};

const stopService = (service: Service): Promise<void> =>
  new Promise((resolve) => {
    if (service.restartTimer) clearTimeout(service.restartTimer);
    const child = service.child;
    if (!child) return resolve();
    const killer = setTimeout(() => signalGroup(child, "SIGKILL"), STOP_GRACE_MS);
    // A last resort: a process that escaped the group and holds the pipes must not block shutdown.
    const giveUp = setTimeout(resolve, STOP_GRACE_MS + 2_000);
    child.once("close", () => {
      clearTimeout(killer);
      clearTimeout(giveUp);
      resolve();
    });
    signalGroup(child, "SIGTERM");
  });

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}: shutting down`);
  await Promise.all(services.map(stopService));
  await mongo?.stop();
  log("Stopped");
  process.exit(0);
};

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => void shutdown(signal));
}

// pnpm exits on SIGTERM without forwarding it, which would orphan this script and everything under it.
if (process.env.npm_lifecycle_event) {
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) void shutdown("pnpm exited");
  }, 1_000).unref();
}

try {
  mongo = await ensureMongo(tools, env, log);
  log(`MongoDB: ${mongo.detail}`);
} catch (e) {
  fail((e as Error).message);
}
if (shuttingDown) await new Promise(() => {});

for (const service of services) startService(service);

// Restarts the backend if its app has crashed behind a still-running `tsx watch`.
const backend = services[0]!;
let seenListening = false;
let misses = 0;
setInterval(() => {
  void isPortOpen(port, HOST).then((open) => {
    if (open) {
      seenListening = true;
      misses = 0;
      return;
    }
    if (!seenListening || shuttingDown || !backend.child) return;
    misses += 1;
    if (misses < WATCHDOG_MISSES) return;
    log("The backend stopped listening, restarting it");
    misses = 0;
    seenListening = false;
    // SIGKILL: `tsx watch` does not exit on SIGTERM once its app has died.
    signalGroup(backend.child, "SIGKILL");
  });
}, WATCHDOG_INTERVAL_MS).unref();

log(`Backend:  http://${HOST}:${port}  (health: /api/health)`);
log(`Frontend: http://${HOST}:${webPort}`);
log(`Stop with Ctrl-C or: kill ${process.pid}`);
