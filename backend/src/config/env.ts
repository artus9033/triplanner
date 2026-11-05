import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const envFile = path.join(REPO_ROOT, ".env");
// Variables already set in the environment win. Values are never logged.
if (existsSync(envFile) && !process.env.VITEST_NO_DOTENV) process.loadEnvFile(envFile);

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** The Claude API key. CLAUDE_API_KEY is an accepted alias of ANTHROPIC_API_KEY. */
export const anthropicApiKey = (): string | undefined =>
  clean(process.env.ANTHROPIC_API_KEY) ?? clean(process.env.CLAUDE_API_KEY);

export const devAccessPassword = (): string | undefined => clean(process.env.DEV_ACCESS_PASSWORD);

export const mongoUri = (): string =>
  clean(process.env.MONGODB_URI) ?? "mongodb://127.0.0.1:27017/triplanner";

export const backendPort = (): number => Number(clean(process.env.PORT) ?? 3000);

const isWritable = (dir: string): boolean => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** /workspace/.tools when /workspace is writable, ~/.tools otherwise. TOOLS_DIR overrides both. */
export const toolsDir = (): string =>
  clean(process.env.TOOLS_DIR) ??
  (isWritable("/workspace") ? "/workspace/.tools" : path.join(homedir(), ".tools"));
