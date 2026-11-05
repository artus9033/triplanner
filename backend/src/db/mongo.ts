import { MongoClient, type Db } from "mongodb";
import { mongoUri } from "../config/env";

let client: MongoClient | null = null;
let db: Db | null = null;

export const connectDb = async (uri: string = mongoUri()): Promise<Db> => {
  if (db) return db;
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 3_000 });
  await client.connect();
  db = client.db();
  return db;
};

export const getDb = (): Db => {
  if (!db) throw new Error("Database is not connected");
  return db;
};

export const closeDb = async (): Promise<void> => {
  await client?.close();
  client = null;
  db = null;
};

export const pingDb = async (): Promise<boolean> => {
  try {
    await getDb().command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
};
