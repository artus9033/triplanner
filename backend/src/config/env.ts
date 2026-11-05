import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APEX_BASE_URL, APEX_MODEL } from "./llm";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const envFile = path.join(REPO_ROOT, ".env");
// Variables already set in the environment win. Values are never logged.
if (existsSync(envFile) && !process.env.VITEST_NO_DOTENV) process.loadEnvFile(envFile);

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** The LLM API key. APEX_API_KEY is the older name and still works. */
export const llmApiKey = (): string | undefined =>
  clean(process.env.LLM_API_KEY) ?? clean(process.env.APEX_API_KEY);

export const llmBaseUrl = (): string => clean(process.env.LLM_BASE_URL) ?? APEX_BASE_URL;

export const llmModelId = (): string => clean(process.env.LLM_MODEL) ?? APEX_MODEL;

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
