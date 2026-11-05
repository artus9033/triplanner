import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { helloMessage, isPortOpen, parseMongoTarget, probeMongo, waitFor } from "./net.ts";

const servers: net.Server[] = [];
const listen = (onData?: (socket: net.Socket) => void): Promise<number> =>
  new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", () => onData?.(socket));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const freePort = async (): Promise<number> => {
  const port = await listen();
  await new Promise((resolve) => servers.pop()?.close(resolve));
  return port;
};

describe("parseMongoTarget", () => {
  it("reads host and port, defaulting the port", () => {
    expect(parseMongoTarget("mongodb://127.0.0.1:27018/x")).toMatchObject({
      host: "127.0.0.1",
      port: 27018,
      local: true,
    });
    expect(parseMongoTarget("mongodb://localhost/x")).toMatchObject({ port: 27017, local: true });
  });
  it("drops credentials, and handles replica sets, IPv6 and SRV", () => {
    const target = parseMongoTarget(
      "mongodb://user:secret@db1.example.com:1,db2.example.com:2/x?tls=true",
    );
    expect(target).toEqual({ host: "db1.example.com", port: 1, local: false, srv: false });
    expect(JSON.stringify(target)).not.toContain("secret");
    expect(parseMongoTarget("mongodb://[::1]:27019/x")).toMatchObject({
      host: "::1",
      port: 27019,
      local: true,
    });
    expect(parseMongoTarget("mongodb+srv://u:p@cluster.example.com/x")).toMatchObject({
      srv: true,
      local: false,
    });
  });
  it("rejects other schemes without echoing the value", () => {
    expect(() => parseMongoTarget("http://secret")).toThrow(/^MONGODB_URI is not/);
  });
});

describe("helloMessage", () => {
  it("is a well-formed OP_MSG", () => {
    const message = helloMessage();
    expect(message.readInt32LE(0)).toBe(message.length);
    expect(message.readInt32LE(12)).toBe(2013);
    const docLength = message.readInt32LE(21);
    expect(21 + docLength).toBe(message.length);
    expect(message.toString("latin1")).toContain("hello\0");
  });
});

describe("probes", () => {
  it("sees a closed port as closed", async () => {
    const port = await freePort();
    expect(await isPortOpen(port)).toBe(false);
    expect(await probeMongo(port)).toBe("closed");
  });

  it("tells a server answering OP_MSG from another service", async () => {
    const mongoLike = await listen((socket) => {
      const reply = Buffer.alloc(16);
      reply.writeInt32LE(2013, 12);
      socket.write(reply);
    });
    const http = await listen((socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
    expect(await isPortOpen(mongoLike)).toBe(true);
    expect(await probeMongo(mongoLike)).toBe("mongo");
    expect(await probeMongo(http)).toBe("other");
  });

  it("sees a silent listener as another service", async () => {
    expect(await probeMongo(await listen(), "127.0.0.1", 50)).toBe("other");
  });
});

describe("waitFor", () => {
  it("returns true once the check passes, false at the deadline", async () => {
    let calls = 0;
    expect(await waitFor(async () => ++calls === 2, 1_000, 1)).toBe(true);
    expect(await waitFor(async () => false, 5, 1)).toBe(false);
  });
});
