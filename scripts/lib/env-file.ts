import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { REPO_ROOT } from "./paths.ts";

/** Parses dotenv text. Values are secrets: callers must never print them. */
export const parseEnvText = (text: string): Record<string, string> =>
  parseEnv(text) as Record<string, string>;

/** Layers file values under the given environment, so variables already set win. */
export const mergeEnv = (
  file: Record<string, string>,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(file)) {
    if (merged[key] === undefined) merged[key] = value;
  }
  return merged;
};

export const envFilePath = (root: string = REPO_ROOT): string => path.join(root, ".env");

/** The process environment with the repo's .env applied, without changing process.env. */
export const loadRepoEnv = (root: string = REPO_ROOT): NodeJS.ProcessEnv => {
  const file = envFilePath(root);
  return mergeEnv(existsSync(file) ? parseEnvText(readFileSync(file, "utf8")) : {}, process.env);
};

/** Reads an optional setting: blank counts as unset, matching backend/src/config/env.ts. */
export const envValue = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const value = env[key]?.trim();
  return value ? value : undefined;
};

export const anthropicKeyFrom = (env: NodeJS.ProcessEnv): string | undefined =>
  envValue(env, "ANTHROPIC_API_KEY") ?? envValue(env, "CLAUDE_API_KEY");
