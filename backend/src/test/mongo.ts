import { execFileSync } from "node:child_process";
import { MongoMemoryServer } from "mongodb-memory-server";
import { closeDb, connectDb } from "../db/mongo";

const systemMongod = (): string | undefined => {
  try {
    return execFileSync("which", ["mongod"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};

/** Starts a throwaway MongoDB and connects the app's db layer to it. Returns a stop function. */
export const startTestDb = async (): Promise<() => Promise<void>> => {
  const systemBinary = systemMongod();
  const server = await MongoMemoryServer.create(
    systemBinary ? { binary: { systemBinary, version: "8.0.0", checkMD5: false } } : undefined,
  );
  await connectDb(server.getUri("triplanner-test"));
  return async () => {
    await closeDb();
    await server.stop();
  };
};
