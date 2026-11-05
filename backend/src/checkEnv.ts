/**
 * The checks that need backend code. Run by scripts/lib/status.ts, which merges these rows into its
 * table. The rows go to stdout as one marked line. Details never contain a secret's value.
 */
import { anthropicApiKey } from "./config/env";
import { speechModelsCached } from "./speech";

type Row = {
  feature: string;
  status: "ready" | "degraded" | "missing";
  detail: string;
  required?: boolean;
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const llmRow = async (): Promise<Row> => {
  const base = { feature: "Claude API key", required: true };
  if (!anthropicApiKey()) {
    return { ...base, status: "missing", detail: "ANTHROPIC_API_KEY is not set in .env" };
  }
  try {
    const { checkLlmKey } = await import("./llm/client");
    return { ...base, ...(await checkLlmKey()) };
  } catch (e) {
    return {
      ...base,
      status: "degraded",
      detail: `set, but could not be verified: ${errorText(e)}`,
    };
  }
};

/** Whether the app itself can use AMPL, as opposed to the binary merely working. */
const optimizerRow = async (): Promise<Row> => {
  const base = { feature: "Optimizer" };
  try {
    const { amplStatus } = await import("./optimizer");
    const { available, detail } = await amplStatus();
    return available
      ? { ...base, status: "ready", detail }
      : { ...base, status: "degraded", detail: `using the fallback heuristic: ${detail}` };
  } catch (e) {
    return { ...base, status: "degraded", detail: `could not load the optimizer: ${errorText(e)}` };
  }
};

const speechRow = (feature: string, cached: boolean): Row =>
  cached
    ? { feature, status: "ready", detail: "model cached" }
    : {
        feature,
        status: "degraded",
        detail: "model not cached yet; downloads when the app first checks speech",
      };

export const collectBackendChecks = async (): Promise<Row[]> => {
  const [llm, optimizer] = await Promise.all([llmRow(), optimizerRow()]);
  const cached = speechModelsCached();
  return [
    llm,
    optimizer,
    speechRow("Speech to text", cached.stt),
    speechRow("Text to speech", cached.tts),
  ];
};

console.log(`__CHECK_ENV__${JSON.stringify(await collectBackendChecks())}`);
process.exit(0);
