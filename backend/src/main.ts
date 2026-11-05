import { backendPort } from "./config/env";
import { connectDb } from "./db/mongo";
import { runBotPool } from "./bots/pool";
import { advanceIntake } from "./intake/machine";
import { checkLlmKey } from "./llm/client";
import { researchPlace } from "./llm/placeBot";
import { proposePlaces } from "./llm/proposals";
import { amplStatus, optimizeTrip } from "./optimizer";
import { createApp } from "./routes/app";
import type { AppDeps } from "./services/deps";
import { createTripFlow } from "./services/tripFlow";
import { speechStatus, synthesize, transcribe } from "./speech";

const deps: AppDeps = {
  advanceIntake,
  proposePlaces,
  researchPlace,
  runBotPool,
  optimizeTrip,
  amplStatus,
  checkLlmKey,
  speechStatus,
  transcribe,
  synthesize,
};

await connectDb();
const flow = createTripFlow(deps);
await flow.recoverInterrupted();
const port = backendPort();
const server = createApp(deps, flow).listen(port, "127.0.0.1", () => {
  console.info(`Backend listening on http://127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
    process.exit(0);
  });
}
