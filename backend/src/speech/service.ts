import type { SpeechStatus } from "@triplanner/shared";
import { decodeAudio } from "./decode";
import { SpeechError } from "./errors";
import { encodeWav } from "./wav";

export type Progress = (p: { loaded: number; total: number }) => void;
export type SttEngine = { transcribe(samples: Float32Array): Promise<string> };
export type TtsEngine = {
  synthesize(text: string): Promise<{ samples: Float32Array; sampleRate: number }>;
};

export type SpeechDeps = {
  loadStt(onProgress: Progress): Promise<SttEngine>;
  loadTts(onProgress: Progress): Promise<TtsEngine>;
  decode?: (audio: Buffer, mime: string) => Promise<Float32Array>;
  now?: () => number;
  /** How long a failed load stays failed before a status call or a request may retry it. */
  retryAfterMs?: number;
  /** A load still unfinished after this long counts as failed. */
  loadTimeoutMs?: number;
};

/** About a minute of speech. Longer text is cut at a sentence boundary. */
export const MAX_TTS_CHARS = 1_000;
/** Kokoro's tokenizer truncates at 510 tokens, so text is synthesized in pieces well below that. */
const TTS_CHUNK_CHARS = 300;
const STT_SAMPLE_RATE_PER_MINUTE = 16_000 * 60;
export const MAX_STT_MINUTES = 10;

const DEFAULT_RETRY_AFTER_MS = 60_000;
const DEFAULT_LOAD_TIMEOUT_MS = 20 * 60_000;

/** Trims to the cap, ending on a sentence when one ends in the second half of the allowed text. */
export const capTtsText = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_TTS_CHARS) return trimmed;
  const head = trimmed.slice(0, MAX_TTS_CHARS);
  const boundary = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  return boundary >= MAX_TTS_CHARS / 2 ? head.slice(0, boundary + 1) : head;
};

/** Splits on sentences, and on spaces inside any sentence too long for one synthesis call. */
export const splitTtsChunks = (text: string, limit = TTS_CHUNK_CHARS): string[] => {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*|[.!?\n]+\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const sentence of sentences) {
    if (current.length + sentence.length > limit) flush();
    if (sentence.length <= limit) {
      current += sentence;
      continue;
    }
    for (const word of sentence.split(/\s+/)) {
      if (current.length + word.length + 1 > limit) flush();
      current += word.length > limit ? word.slice(0, limit) : `${word} `;
    }
  }
  flush();
  return chunks;
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const formatProgress = (label: string, loaded: number, total: number): string =>
  `Downloading the ${label} model: ${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB`;

class Feature<E> {
  private state: "idle" | "loading" | "ready" | "failed" = "idle";
  private engine: E | null = null;
  private inflight: Promise<E> | null = null;
  private reason: string | null = null;
  private failedAt = 0;
  private readonly label: string;
  private readonly load: (onProgress: Progress) => Promise<E>;
  private readonly now: () => number;
  private readonly retryAfterMs: number;
  private readonly loadTimeoutMs: number;

  constructor(
    label: string,
    load: (onProgress: Progress) => Promise<E>,
    now: () => number,
    retryAfterMs: number,
    loadTimeoutMs: number,
  ) {
    this.label = label;
    this.load = load;
    this.now = now;
    this.retryAfterMs = retryAfterMs;
    this.loadTimeoutMs = loadTimeoutMs;
  }

  private start(): Promise<E> {
    this.state = "loading";
    this.reason = `Preparing the ${this.label} model`;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`Timed out after ${Math.round(this.loadTimeoutMs / 60_000)} minutes`)),
        this.loadTimeoutMs,
      );
      timer.unref();
    });
    const onProgress: Progress = ({ loaded, total }) => {
      if (this.state === "loading") this.reason = formatProgress(this.label, loaded, total);
    };
    // The async wrapper turns a synchronous throw from the loader into a rejection too.
    const run = (async () => this.load(onProgress))();
    this.inflight = Promise.race([run, timeout])
      .then((engine) => {
        this.engine = engine;
        this.state = "ready";
        this.reason = null;
        return engine;
      })
      .catch((e: unknown) => {
        this.state = "failed";
        this.failedAt = this.now();
        this.reason = `The ${this.label} model is unavailable: ${errorText(e)}`;
        throw new SpeechError(503, this.reason);
      })
      .finally(() => {
        clearTimeout(timer);
        this.inflight = null;
      });
    // Callers may await this later or never; a failure is recorded in the state either way.
    this.inflight.catch(() => {});
    return this.inflight;
  }

  private retryAllowed(): boolean {
    return this.now() - this.failedAt >= this.retryAfterMs;
  }

  /** Starts a load in the background if one is due. Never throws. */
  kick(): void {
    if (this.state === "idle" || (this.state === "failed" && this.retryAllowed()))
      void this.start().catch(() => {});
  }

  status(): SpeechStatus["stt"] {
    if (this.state === "ready") return { status: "ready", reason: null };
    if (this.state === "failed") return { status: "unavailable", reason: this.reason };
    return { status: "downloading", reason: this.reason };
  }

  /** The loaded engine, waiting for a load in progress. Rejects while a recent failure stands. */
  async ready(): Promise<E> {
    if (this.engine) return this.engine;
    if (this.inflight) return this.inflight;
    if (this.state === "failed" && !this.retryAllowed())
      throw new SpeechError(503, this.reason ?? "unavailable");
    return this.start();
  }
}

export type SpeechService = {
  speechStatus(): SpeechStatus;
  transcribe(audio: Buffer, mime: string): Promise<string>;
  synthesize(text: string): Promise<Buffer>;
};

export const createSpeechService = (deps: SpeechDeps): SpeechService => {
  const now = deps.now ?? Date.now;
  const retryAfterMs = deps.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  const loadTimeoutMs = deps.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  const decode = deps.decode ?? ((audio, mime) => decodeAudio(audio, mime));
  const stt = new Feature("speech-to-text", deps.loadStt, now, retryAfterMs, loadTimeoutMs);
  const tts = new Feature("text-to-speech", deps.loadTts, now, retryAfterMs, loadTimeoutMs);

  // One inference at a time across both models; a failed job does not block the next one.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(job: () => Promise<T>): Promise<T> => {
    const result = queue.then(job, job);
    queue = result.catch(() => {});
    return result;
  };

  return {
    speechStatus: () => {
      stt.kick();
      tts.kick();
      return { stt: stt.status(), tts: tts.status() };
    },

    transcribe: async (audio, mime) => {
      // Decode first, so bad input is reported without waiting for a model download.
      const samples = await decode(audio, mime);
      if (samples.length > MAX_STT_MINUTES * STT_SAMPLE_RATE_PER_MINUTE) {
        throw new SpeechError(400, `The audio is longer than ${MAX_STT_MINUTES} minutes`);
      }
      const engine = await stt.ready();
      return serialized(() => engine.transcribe(samples));
    },

    synthesize: async (text) => {
      const capped = capTtsText(text);
      if (!capped) throw new SpeechError(400, "There is no text to read aloud");
      const engine = await tts.ready();
      const parts = await serialized(async () => {
        const out: { samples: Float32Array; sampleRate: number }[] = [];
        for (const chunk of splitTtsChunks(capped)) out.push(await engine.synthesize(chunk));
        return out;
      });
      const sampleRate = parts[0]?.sampleRate ?? 24_000;
      const joined = new Float32Array(parts.reduce((n, part) => n + part.samples.length, 0));
      let at = 0;
      for (const part of parts) {
        joined.set(part.samples, at);
        at += part.samples.length;
      }
      return encodeWav(joined, sampleRate);
    },
  };
};
