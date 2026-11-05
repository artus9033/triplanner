import net from "node:net";

/** True when something accepts TCP connections on the port. */
export const isPortOpen = (port: number, host = "127.0.0.1", timeoutMs = 1_000): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

export type MongoTarget = { host: string; port: number; local: boolean; srv: boolean };

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Reads the first host out of a MongoDB URI. The result carries no credentials, so it can be printed. */
export const parseMongoTarget = (uri: string): MongoTarget => {
  const match = /^mongodb(\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri.trim());
  if (!match) throw new Error("MONGODB_URI is not a mongodb:// or mongodb+srv:// URI");
  const srv = Boolean(match[1]);
  const first = (match[2] ?? "").split(",")[0] ?? "";
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(first);
  const [host, port] = bracketed ? [bracketed[1], bracketed[2]] : first.split(":");
  const name = host ?? "";
  return { host: name, port: Number(port ?? 27017), local: LOCAL_HOSTS.has(name), srv };
};

/** An OP_MSG {hello: 1, $db: "admin"} message, built by hand so scripts need no driver. */
export const helloMessage = (): Buffer => {
  const element = (type: number, name: string, value: Buffer) =>
    Buffer.concat([Buffer.from([type]), Buffer.from(`${name}\0`, "latin1"), value]);
  const int32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(n);
    return b;
  };
  const dbName = Buffer.from("admin\0", "latin1");
  const elements = Buffer.concat([
    element(0x10, "hello", int32(1)),
    element(0x02, "$db", Buffer.concat([int32(dbName.length), dbName])),
    Buffer.from([0]),
  ]);
  const doc = Buffer.concat([int32(elements.length + 4), elements]);
  const body = Buffer.concat([int32(0), Buffer.from([0]), doc]);
  const header = Buffer.alloc(16);
  header.writeInt32LE(16 + body.length, 0);
  header.writeInt32LE(1, 4);
  header.writeInt32LE(0, 8);
  header.writeInt32LE(2013, 12);
  return Buffer.concat([header, body]);
};

export type MongoProbe = "mongo" | "closed" | "other";

/** Tells a MongoDB server apart from a closed port and from some other service on that port. */
export const probeMongo = (
  port: number,
  host = "127.0.0.1",
  timeoutMs = 2_000,
): Promise<MongoProbe> =>
  new Promise((resolve) => {
    let connected = false;
    const socket = net.connect({ port, host });
    const done = (result: MongoProbe) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(connected ? "other" : "closed"));
    socket.once("connect", () => {
      connected = true;
      socket.write(helloMessage());
    });
    socket.once("data", (reply: Buffer) => {
      done(reply.length >= 16 && reply.readInt32LE(12) === 2013 ? "mongo" : "other");
    });
    socket.once("error", () => done(connected ? "other" : "closed"));
    socket.once("end", () => done(connected ? "other" : "closed"));
  });

export const waitFor = async (
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
};
