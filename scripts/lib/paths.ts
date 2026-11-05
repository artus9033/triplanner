import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const isWritable = (dir: string): boolean => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** TOOLS_DIR when set, /workspace/.tools when /workspace is writable, ~/.tools otherwise. */
export const resolveToolsDir = (
  env: NodeJS.ProcessEnv = process.env,
  writable: (dir: string) => boolean = isWritable,
  home: string = homedir(),
): string => {
  const override = env.TOOLS_DIR?.trim();
  if (override) return override;
  return writable("/workspace") ? "/workspace/.tools" : path.join(home, ".tools");
};
