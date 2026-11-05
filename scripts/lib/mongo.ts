import { spawn, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { envValue } from "./env-file.ts";
import { lastLine, run } from "./exec.ts";
import { parseMongoTarget, probeMongo, waitFor, type MongoProbe, type MongoTarget } from "./net.ts";
import { REPO_ROOT } from "./paths.ts";

/** Keep in step with the image tag in docker-compose.yml. */
export const MONGOD_VERSION = "8.0.34";
const DEFAULT_URI = "mongodb://127.0.0.1:27017/triplanner";
const START_TIMEOUT_MS = 30_000;

export const mongoUriFrom = (env: NodeJS.ProcessEnv): string =>
  envValue(env, "MONGODB_URI") ?? DEFAULT_URI;
export const mongoTargetFrom = (env: NodeJS.ProcessEnv): MongoTarget =>
  parseMongoTarget(mongoUriFrom(env));

/** Probes the configured server. An SRV URI has no single host to probe, so it is assumed reachable. */
export const probeTarget = (target: MongoTarget): Promise<MongoProbe> =>
  target.srv ? Promise.resolve("mongo") : probeMongo(target.port, target.host);

const parseOsRelease = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split("\n")
      .map((line) => /^([A-Z_]+)=["']?([^"'\n]*)["']?$/.exec(line.trim()))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1] ?? "", m[2] ?? ""]),
  );

/** Picks the build name MongoDB publishes for a Linux distro (/etc/os-release contents). */
export const linuxTarget = (osRelease: string, arch: "x86_64" | "aarch64"): string => {
  const fields = parseOsRelease(osRelease);
  const ids = `${fields.ID ?? ""} ${fields.ID_LIKE ?? ""}`;
  const major = Number((fields.VERSION_ID ?? "").split(".")[0]);
  if (fields.ID === "ubuntu" || / ubuntu/.test(ids)) {
    const version = Number((fields.VERSION_ID ?? "").replace(".", ""));
    if (fields.ID === "ubuntu" && version >= 2404) return "ubuntu2404";
    if (fields.ID === "ubuntu" && version < 2204 && version > 0) return "ubuntu2004";
    return "ubuntu2204";
  }
  if (fields.ID === "debian") {
    // There is no aarch64 Debian build; the Ubuntu 22.04 one has compatible library versions.
    return arch === "x86_64" && major >= 12 ? "debian12" : "ubuntu2204";
  }
  if (fields.ID === "amzn" && major >= 2023) return "amazon2023";
  if (/rhel|fedora|centos|rocky|almalinux/.test(ids)) {
    if (fields.ID === "fedora" || major >= 10) return "rhel10";
    return major >= 9 ? "rhel93" : "rhel8";
  }
  return "ubuntu2204";
};

/** The official tarball URL for this OS and architecture, or null when there is no build. */
export const mongodUrl = (
  platform: NodeJS.Platform,
  arch: string,
  osRelease: string,
  version: string = MONGOD_VERSION,
): string | null => {
  if (platform === "darwin") {
    const name = arch === "arm64" ? "arm64" : arch === "x64" ? "x86_64" : null;
    return name && `https://fastdl.mongodb.org/osx/mongodb-macos-${name}-${version}.tgz`;
  }
  if (platform === "linux") {
    const name = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null;
    if (!name) return null;
    const target = linuxTarget(osRelease, name);
    return `https://fastdl.mongodb.org/linux/mongodb-linux-${name}-${target}-${version}.tgz`;
  }
  return null;
};

export const currentMongodUrl = (): string | null => {
  const release = existsSync("/etc/os-release") ? readFileSync("/etc/os-release", "utf8") : "";
  return mongodUrl(process.platform, process.arch, release);
};

export const urlExists = async (url: string): Promise<boolean> => {
  try {
    return (await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) })).ok;
  } catch {
    return false;
  }
};

const tarballDir = (tools: string): string => path.join(tools, `mongodb-${MONGOD_VERSION}`);
/** Beside the binaries, not inside them, so a reinstall or upgrade keeps the trips. */
export const mongoDataDir = (tools: string): string => path.join(tools, "mongodb-data");
const mongoLogFile = (tools: string): string => path.join(tools, "mongod.log");

const works = async (binary: string, env: NodeJS.ProcessEnv): Promise<boolean> =>
  (await run(binary, ["--version"], { env, timeoutMs: 15_000 })).ok;

/** A mongod that actually runs: the system's if there is one, otherwise the tarball under TOOLS_DIR. */
export const findMongod = async (
  tools: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> => {
  if (await works("mongod", env)) return "mongod";
  const local = path.join(tarballDir(tools), "bin", "mongod");
  return existsSync(local) && (await works(local, env)) ? local : undefined;
};

/** Downloads and unpacks the tarball, replacing a broken copy. Throws with the reason on failure. */
export const installMongodTarball = async (
  tools: string,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void = () => {},
  url: string | null = currentMongodUrl(),
): Promise<string> => {
  if (!url) throw new Error(`MongoDB publishes no tarball for ${process.platform}/${process.arch}`);
  mkdirSync(tools, { recursive: true });
  const archive = path.join(tools, `.mongodb-${MONGOD_VERSION}.${process.pid}.tgz`);
  const staging = `${tarballDir(tools)}.${process.pid}.tmp`;
  try {
    log(`MongoDB: downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok || !response.body)
      throw new Error(`download failed with HTTP ${response.status}: ${url}`);
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream),
      createWriteStream(archive),
    );
    mkdirSync(staging, { recursive: true });
    const unpack = await run("tar", ["-xzf", archive, "-C", staging, "--strip-components=1"], {
      timeoutMs: 300_000,
    });
    if (!unpack.ok)
      throw new Error(`could not unpack the tarball: ${unpack.error ?? lastLine(unpack.stderr)}`);
    rmSync(tarballDir(tools), { recursive: true, force: true });
    renameSync(staging, tarballDir(tools));
  } finally {
    rmSync(archive, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
  const binary = path.join(tarballDir(tools), "bin", "mongod");
  const check = await run(binary, ["--version"], { env, timeoutMs: 15_000 });
  if (!check.ok) {
    throw new Error(
      `the downloaded mongod does not run here: ${check.error ?? lastLine(check.stderr)}`,
    );
  }
  return binary;
};

/** Docker counts as working only if the engine answers and compose is available. */
export const dockerWorks = async (env: NodeJS.ProcessEnv): Promise<boolean> => {
  const engine = await run("docker", ["info"], { env, timeoutMs: 15_000 });
  if (!engine.ok) return false;
  return (await run("docker", ["compose", "version"], { env, timeoutMs: 15_000 })).ok;
};

export type MongoHandle = {
  /** How this run got its database. */
  via: "existing" | "docker" | "mongod";
  detail: string;
  /** Stops what this run started. Does nothing for a server that was already running. */
  stop(): Promise<void>;
};

const startWithDocker = async (
  target: MongoTarget,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void,
): Promise<MongoHandle | null> => {
  const composeEnv = { ...env, MONGO_PORT: String(target.port) };
  log("MongoDB: starting with docker compose");
  const up = await run("docker", ["compose", "up", "-d", "mongo"], {
    env: composeEnv,
    cwd: REPO_ROOT,
    timeoutMs: 300_000,
  });
  if (!up.ok) {
    log(`MongoDB: docker compose failed (${up.error ?? lastLine(up.stderr)}), trying mongod`);
    return null;
  }
  if (!(await waitFor(async () => (await probeTarget(target)) === "mongo", START_TIMEOUT_MS))) {
    log("MongoDB: the container did not become reachable, trying mongod");
    await run("docker", ["compose", "stop", "mongo"], {
      env: composeEnv,
      cwd: REPO_ROOT,
      timeoutMs: 60_000,
    });
    return null;
  }
  return {
    via: "docker",
    detail: `docker compose on port ${target.port}`,
    stop: async () => {
      log("MongoDB: stopping the container (its volume keeps the data)");
      await run("docker", ["compose", "stop", "mongo"], {
        env: composeEnv,
        cwd: REPO_ROOT,
        timeoutMs: 60_000,
      });
    },
  };
};

const logTail = (file: string): string => {
  try {
    return readFileSync(file, "utf8").trim().split("\n").slice(-3).join("\n");
  } catch {
    return "";
  }
};

const stopChild = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.once("exit", () => {
      clearTimeout(killer);
      resolve();
    });
    child.kill("SIGTERM");
  });

const startMongod = async (
  binary: string,
  target: MongoTarget,
  tools: string,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void,
): Promise<MongoHandle> => {
  const dbpath = mongoDataDir(tools);
  mkdirSync(dbpath, { recursive: true });
  const logFile = mongoLogFile(tools);
  log(`MongoDB: starting ${binary} with data in ${dbpath}`);
  // Its own process group, so Ctrl-C reaches it only through stop(), after the app has shut down.
  const output = openSync(logFile, "a");
  const child = spawn(
    binary,
    // No Unix socket: nothing here uses one, and a stale /tmp/mongodb-<port>.sock owned by another user
    // (common on a shared machine) would stop mongod from starting.
    ["--dbpath", dbpath, "--bind_ip", "127.0.0.1", "--port", String(target.port), "--nounixsocket"],
    { env, detached: true, stdio: ["ignore", output, output] },
  );
  let exited = false;
  child.once("exit", () => (exited = true));
  child.once("error", () => (exited = true));
  const up = await waitFor(
    async () => exited || (await probeTarget(target)) === "mongo",
    START_TIMEOUT_MS,
  );
  if (!up || exited) {
    await stopChild(child);
    throw new Error(`mongod did not start. See ${logFile}:\n${logTail(logFile)}`);
  }
  return {
    via: "mongod",
    detail: `${binary} on port ${target.port}, data in ${dbpath}`,
    stop: async () => {
      log("MongoDB: stopping the mongod this run started (its data stays on disk)");
      await stopChild(child);
    },
  };
};

const noop = async (): Promise<void> => {};

/**
 * Gets a reachable MongoDB: (a) reuse the configured one, (b) docker compose, (c) mongod.
 * Never touches a process it did not start. Throws with a message to show the user.
 */
export const ensureMongo = async (
  tools: string,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void = () => {},
): Promise<MongoHandle> => {
  const target = mongoTargetFrom(env);
  const where = `${target.host}:${target.port}`;
  const probe = await probeTarget(target);
  if (probe === "mongo") {
    return { via: "existing", detail: `reusing the server already on ${where}`, stop: noop };
  }
  if (probe === "other") {
    throw new Error(
      `Port ${target.port} on ${target.host} is in use by something that is not MongoDB. It was left alone. Set MONGODB_URI to a free port.`,
    );
  }
  if (!target.local) {
    throw new Error(
      `MongoDB at ${where} (from MONGODB_URI) is not reachable, and it is not local so it cannot be started here.`,
    );
  }
  if (await dockerWorks(env)) {
    const docker = await startWithDocker(target, env, log);
    if (docker) return docker;
  }
  const binary = await findMongod(tools, env);
  if (!binary) {
    throw new Error(
      "No MongoDB available: Docker does not work and there is no mongod. Run `pnpm run bootstrap` to install it.",
    );
  }
  return startMongod(binary, target, tools, env, log);
};
