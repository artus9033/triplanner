import { createHash, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { OptimizeRequestSchema, type FeatureHealth, type Health } from "@triplanner/shared";
import { devAccessPassword } from "../config/env";
import { pingDb } from "../db/mongo";
import { createTrip, deleteTrip, getTrip, listTrips } from "../db/trips";
import type { AppDeps } from "../services/deps";
import { HttpError, userMessageOf } from "../services/errors";
import { subscribeTrip } from "../services/events";
import type { TripFlow } from "../services/tripFlow";

const COOKIE = "triplanner_gate";
const LLM_CHECK_TTL_MS = 60_000;
const MAX_TTS_CHARS = 4_000;

const sha256 = (text: string): Buffer => createHash("sha256").update(text).digest();

const readCookie = (req: Request): string | undefined =>
  req.headers.cookie
    ?.split(";")
    .map((c) => c.trim().split("="))
    .find(([name]) => name === COOKIE)?.[1];

const hasGateCookie = (req: Request, password: string): boolean => {
  const cookie = readCookie(req);
  if (!cookie) return false;
  const given = Buffer.from(cookie, "hex");
  const expected = sha256(password);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const body = <T>(schema: z.ZodType<T>, req: Request): T => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, "The request is not valid.");
  return parsed.data;
};

const param = (req: Request, name: string): string => String(req.params[name]);

export const createApp = (deps: AppDeps, flow: TripFlow) => {
  const app = express();
  app.disable("x-powered-by");

  let llmCheck: { at: number; value: FeatureHealth } | null = null;
  const llmHealth = async (): Promise<FeatureHealth> => {
    if (llmCheck && Date.now() - llmCheck.at < LLM_CHECK_TTL_MS) return llmCheck.value;
    const check = await deps.checkLlmKey();
    const value: FeatureHealth = { status: check.status, detail: check.detail };
    llmCheck = { at: Date.now(), value };
    return value;
  };

  // Details stay behind the gate, but liveness remains checkable without the password.
  const gated = (req: Request): boolean => {
    const password = devAccessPassword();
    return password !== undefined && !hasGateCookie(req, password);
  };

  app.get("/api/health", async (req, res) => {
    if (gated(req)) {
      res.json({ ok: true, gated: true });
      return;
    }
    const dbUp = await pingDb();
    const [ampl, llm] = await Promise.all([deps.amplStatus(), llmHealth()]);
    const speech = deps.speechStatus();
    const speechReady = speech.stt.status === "ready" && speech.tts.status === "ready";
    const health: Health = {
      ok: dbUp,
      db: { status: dbUp ? "ready" : "missing", detail: dbUp ? "Connected" : "Not reachable" },
      ampl: {
        status: ampl.available ? "ready" : "degraded",
        detail: ampl.detail,
      },
      speech: {
        status: speechReady ? "ready" : "degraded",
        detail: speechReady
          ? "Speech models loaded"
          : `Speech to text: ${speech.stt.reason ?? speech.stt.status}. Text to speech: ${speech.tts.reason ?? speech.tts.status}.`,
      },
      llm,
    };
    res.json(health);
  });

  app.post("/api/auth", express.json(), (req, res) => {
    const password = devAccessPassword();
    if (!password) {
      res.status(204).end();
      return;
    }
    const { password: given } = body(z.object({ password: z.string() }), req);
    if (!timingSafeEqual(sha256(given), sha256(password))) {
      throw new HttpError(401, "Wrong password.");
    }
    res.cookie(COOKIE, sha256(password).toString("hex"), { httpOnly: true, sameSite: "lax" });
    res.status(204).end();
  });

  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (gated(req)) {
      res.status(401).json({ error: "This app needs a password." });
      return;
    }
    next();
  });

  // Audio has its own parser and size limit, so these routes come before the JSON parser.
  app.get("/api/speech/status", (_req, res) => {
    res.json(deps.speechStatus());
  });
  app.post(
    "/api/speech/transcribe",
    express.raw({ type: () => true, limit: "25mb" }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new HttpError(400, "No audio was received.");
      }
      const text = await deps.transcribe(req.body, req.headers["content-type"] ?? "audio/wav");
      res.json({ text });
    },
  );

  app.use(express.json({ limit: "1mb" }));

  app.post("/api/speech/tts", async (req, res) => {
    const { text } = body(z.object({ text: z.string().min(1).max(MAX_TTS_CHARS) }), req);
    const wav = await deps.synthesize(text);
    res.type("audio/wav").send(wav);
  });

  app.get("/api/trips", async (_req, res) => {
    res.json(await listTrips());
  });
  app.post("/api/trips", async (_req, res) => {
    res.status(201).json(await createTrip());
  });
  app.get("/api/trips/:id", async (req, res) => {
    const trip = await getTrip(param(req, "id"));
    if (!trip) throw new HttpError(404, "Trip not found");
    res.json(trip);
  });
  app.delete("/api/trips/:id", async (req, res) => {
    if (!(await deleteTrip(param(req, "id")))) throw new HttpError(404, "Trip not found");
    res.status(204).end();
  });

  app.get("/api/trips/:id/events", async (req, res) => {
    const id = param(req, "id");
    if (!(await getTrip(id))) throw new HttpError(404, "Trip not found");
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    const unsubscribe = subscribeTrip(id, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.post("/api/trips/:id/messages", async (req, res) => {
    const { content } = body(z.object({ content: z.string().trim().min(1).max(4_000) }), req);
    res.json(await flow.sendMessage(param(req, "id"), content));
  });
  app.post("/api/trips/:id/proposals/retry", async (req, res) => {
    res.json(await flow.retryProposals(param(req, "id")));
  });
  app.post("/api/trips/:id/proposals/confirm", async (req, res) => {
    const { placeIds } = body(z.object({ placeIds: z.array(z.string()) }), req);
    res.json(await flow.confirmProposals(param(req, "id"), placeIds));
  });
  app.post("/api/trips/:id/places/:placeId/retry", async (req, res) => {
    res.json(await flow.retryPlace(param(req, "id"), param(req, "placeId")));
  });
  app.post("/api/trips/:id/optimize", async (req, res) => {
    res.json(await flow.optimize(param(req, "id"), body(OptimizeRequestSchema, req)));
  });
  app.post("/api/trips/:id/finalize", async (req, res) => {
    res.json(await flow.finalize(param(req, "id")));
  });

  app.use("/api", (_req, _res) => {
    throw new HttpError(404, "Not found");
  });

  // Every failure reaches the screen as text. Internal details go to the log only.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      err instanceof HttpError
        ? err.status
        : typeof (err as { status?: unknown }).status === "number"
          ? (err as { status: number }).status >= 500
            ? 500
            : (err as { status: number }).status
          : (err as { userMessage?: unknown }).userMessage
            ? 502
            : 500;
    if (status >= 500) console.error("Request failed:", (err as Error).message);
    res.status(status).json({ error: userMessageOf(err, "Something went wrong on the server.") });
  });

  return app;
};
