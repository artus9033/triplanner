import { chmodSync, constants, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { ensureAmpl } from "./lib/ampl.ts";
import { envFilePath, loadRepoEnv } from "./lib/env-file.ts";
import { run } from "./lib/exec.ts";
import {
  currentMongodUrl,
  dockerWorks,
  findMongod,
  installMongodTarball,
  mongoTargetFrom,
  probeTarget,
  urlExists,
} from "./lib/mongo.ts";
import { REPO_ROOT, resolveToolsDir } from "./lib/paths.ts";
import { collectStatus, nodeRow } from "./lib/status.ts";
import { formatTable, type StatusRow } from "./lib/table.ts";

const log = (message: string) => console.log(`[bootstrap] ${message}`);

const node = nodeRow();
log(`Node: ${node.detail}`);
if (node.status === "missing") {
  console.error(`[bootstrap] Install the Node version in .nvmrc first: ${node.detail}`);
  process.exit(1);
}

log("Installing dependencies");
const frozen = await run("pnpm", ["install", "--frozen-lockfile"], {
  cwd: REPO_ROOT,
  inherit: true,
});
if (!frozen.ok) {
  log("The frozen install failed, retrying without --frozen-lockfile");
  const relaxed = await run("pnpm", ["install", "--no-frozen-lockfile"], {
    cwd: REPO_ROOT,
    inherit: true,
  });
  if (!relaxed.ok) {
    console.error("[bootstrap] pnpm install failed. See the output above.");
    process.exit(1);
  }
}

const envFile = envFilePath();
if (existsSync(envFile)) {
  log(".env exists, leaving it alone");
} else {
  // COPYFILE_EXCL makes this fail rather than overwrite, even in a race with another process.
  copyFileSync(path.join(REPO_ROOT, ".env.example"), envFile, constants.COPYFILE_EXCL);
  chmodSync(envFile, 0o600);
  log("Created .env from .env.example (mode 600). Fill in APEX_API_KEY.");
}

const env = loadRepoEnv();
const tools = resolveToolsDir(env);
log(`Tools directory: ${tools}`);

const ampl = await ensureAmpl(tools, env, log);
log(`AMPL: ${ampl.level}: ${ampl.detail}`);

/** Installs the tarball only when nothing else can provide MongoDB. Problems become table rows. */
const ensureMongoAvailable = async (): Promise<StatusRow | null> => {
  let target;
  try {
    target = mongoTargetFrom(env);
  } catch {
    return null;
  }
  if (!target.local || (await probeTarget(target)) !== "closed") {
    log("MongoDB: already reachable or external, nothing to install");
    return null;
  }
  if (await dockerWorks(env)) {
    log("MongoDB: Docker works, pnpm dev will use docker compose");
    return null;
  }
  const existing = await findMongod(tools, env);
  if (existing) {
    log(`MongoDB: found ${existing}`);
    return null;
  }
  const url = currentMongodUrl();
  if (!url || !(await urlExists(url))) {
    const why = url
      ? `${url} is not available`
      : `no build for ${process.platform}/${process.arch}`;
    return { feature: "mongod install", status: "missing", detail: why };
  }
  try {
    await installMongodTarball(tools, env, log, url);
    log("MongoDB: tarball installed");
    return null;
  } catch (e) {
    return { feature: "mongod install", status: "missing", detail: (e as Error).message };
  }
};
const mongoProblem = await ensureMongoAvailable();

const rows = await collectStatus(tools, env);
console.log(`\n${formatTable(mongoProblem ? [...rows, mongoProblem] : rows)}\n`);
log("Done. Start the app with: pnpm dev");
