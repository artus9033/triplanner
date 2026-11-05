import { loadRepoEnv } from "./lib/env-file.ts";
import { resolveToolsDir } from "./lib/paths.ts";
import { collectStatus } from "./lib/status.ts";
import { formatTable, hasRequiredMissing } from "./lib/table.ts";

const env = loadRepoEnv();
const rows = await collectStatus(resolveToolsDir(env), env);
console.log(formatTable(rows));
if (hasRequiredMissing(rows)) {
  console.error("\nSomething required is missing: see the rows marked missing above.");
  process.exit(1);
}
