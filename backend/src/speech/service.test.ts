import { describe, expect, it, vi } from "vitest";
import {
  capTtsText,
  createSpeechService,
  MAX_TTS_CHARS,
  splitTtsChunks,
  type SpeechDeps,
} from "./service";
import { encodeWav, parseWav } from "./wav";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));
const stt = { transcribe: async () => "hello" };
const tts = {
  synthesize: async () => ({ samples: new Float32Array([0.5, 0.5]), sampleRate: 24_000 }),
};
const fake = (over: Partial<SpeechDeps> = {}): SpeechDeps => ({
  loadStt: async () => stt,
  loadTts: async () => tts,
  decode: async () => new Float32Array(16),
  ...over,
});
const wav = encodeWav(new Float32Array(16_000), 16_000);

describe("speech status machine", () => {
  it("does nothing until the first status call, then downloads, then is ready", async () => {
    const gate = deferred<typeof stt>();
    const loadStt = vi.fn(() => gate.promise);
    const service = createSpeechService(fake({ loadStt }));
    expect(loadStt).not.toHaveBeenCalled();

    expect(service.speechStatus().stt.status).toBe("downloading");
    expect(loadStt).toHaveBeenCalledTimes(1);
    service.speechStatus();
    expect(loadStt).toHaveBeenCalledTimes(1);

    gate.resolve(stt);
    await flush();
    expect(service.speechStatus().stt).toEqual({ status: "ready", reason: null });
    expect(service.speechStatus().tts).toEqual({ status: "ready", reason: null });
  });

  it("reports download progress as the reason", async () => {
    const service = createSpeechService(
      fake({
        loadStt: (onProgress) => {
          onProgress({ loaded: 5_000_000, total: 40_000_000 });
          return new Promise(() => {});
        },
      }),
    );
    expect(service.speechStatus().stt.reason).toContain("5 of 40 MB");
  });

  it("reports a failed load as unavailable, and retries only after the wait", async () => {
    let time = 0;
    const loadTts = vi.fn(async () => {
      if (loadTts.mock.calls.length === 1) throw new Error("network down");
      return tts;
    });
    const service = createSpeechService(fake({ loadTts, now: () => time, retryAfterMs: 1_000 }));
    service.speechStatus();
    await flush();
    const failed = service.speechStatus().tts;
    expect(failed.status).toBe("unavailable");
    expect(failed.reason).toContain("network down");
    expect(loadTts).toHaveBeenCalledTimes(1);

    time = 999;
    service.speechStatus();
    expect(loadTts).toHaveBeenCalledTimes(1);

    time = 1_000;
    expect(service.speechStatus().tts.status).toBe("downloading");
    expect(loadTts).toHaveBeenCalledTimes(2);
    await flush();
    expect(service.speechStatus().tts.status).toBe("ready");
  });

  it("treats a loader that throws synchronously as a failed load", async () => {
    const service = createSpeechService(
      fake({
        loadStt: () => {
          throw new Error("native module missing");
        },
      }),
    );
    expect(() => service.speechStatus()).not.toThrow();
    await flush();
    expect(service.speechStatus().stt.reason).toContain("native module missing");
  });

  it("fails a load that never finishes", async () => {
    const service = createSpeechService(
      fake({ loadStt: () => new Promise(() => {}), loadTimeoutMs: 1 }),
    );
    service.speechStatus();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const { status, reason } = service.speechStatus().stt;
    expect(status).toBe("unavailable");
    expect(reason).toContain("Timed out");
  });
});

describe("transcribe", () => {
  it("waits for a load in progress", async () => {
    const gate = deferred<typeof stt>();
    const service = createSpeechService(fake({ loadStt: () => gate.promise }));
    const text = service.transcribe(wav, "audio/wav");
    await flush();
    gate.resolve(stt);
    await expect(text).resolves.toBe("hello");
  });

  it("reports bad audio without loading a model", async () => {
    const loadStt = vi.fn(async () => stt);
    const service = createSpeechService({ ...fake({ loadStt }), decode: undefined });
    await expect(service.transcribe(Buffer.alloc(0), "audio/wav")).rejects.toThrow(/empty/);
    expect(loadStt).not.toHaveBeenCalled();
  });

  it("rejects with the reason while a recent failure stands", async () => {
    const loadStt = vi.fn(async () => {
      throw new Error("disk full");
    });
    const service = createSpeechService(fake({ loadStt, retryAfterMs: 60_000 }));
    await expect(service.transcribe(wav, "audio/wav")).rejects.toThrow(/disk full/);
    await expect(service.transcribe(wav, "audio/wav")).rejects.toThrow(/disk full/);
    expect(loadStt).toHaveBeenCalledTimes(1);
  });

  it("marks errors with text that is safe to show on screen", async () => {
    const service = createSpeechService(
      fake({ loadStt: async () => Promise.reject(new Error("disk full")) }),
    );
    await expect(service.transcribe(wav, "audio/wav")).rejects.toMatchObject({
      status: 503,
      userMessage: expect.stringContaining("disk full"),
    });
    await expect(createSpeechService(fake()).synthesize(" ")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects audio over the length limit", async () => {
    const service = createSpeechService(
      fake({ decode: async () => ({ length: 16_000 * 60 * 11 }) as Float32Array }),
    );
    await expect(service.transcribe(wav, "audio/wav")).rejects.toThrow(/longer than 10 minutes/);
  });
});

describe("synthesize", () => {
  it("returns a WAV holding the audio of every chunk", async () => {
    const service = createSpeechService(fake());
    const text = `${"First sentence goes here. ".repeat(20)}`;
    const { samples, sampleRate } = parseWav(await service.synthesize(text));
    expect(sampleRate).toBe(24_000);
    expect(samples.length).toBe(splitTtsChunks(text.trim()).length * 2);
  });

  it("rejects empty text", async () => {
    await expect(createSpeechService(fake()).synthesize("  ")).rejects.toThrow(/no text/);
  });

  it("runs one inference at a time across both models, and survives a failed job", async () => {
    let active = 0;
    let peak = 0;
    const tracked = async <T>(value: T, fail = false): Promise<T> => {
      active += 1;
      peak = Math.max(peak, active);
      await flush();
      active -= 1;
      if (fail) throw new Error("inference failed");
      return value;
    };
    let calls = 0;
    const service = createSpeechService(
      fake({
        loadStt: async () => ({ transcribe: () => tracked("text", ++calls === 1) }),
        loadTts: async () => ({
          synthesize: () => tracked({ samples: new Float32Array(1), sampleRate: 24_000 }),
        }),
      }),
    );
    const results = await Promise.allSettled([
      service.transcribe(wav, "audio/wav"),
      service.synthesize("one"),
      service.transcribe(wav, "audio/wav"),
      service.synthesize("two"),
    ]);
    expect(peak).toBe(1);
    expect(results.map((r) => r.status)).toEqual([
      "rejected",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
  });
});

describe("TTS text handling", () => {
  it("caps long text at a sentence end when there is one", () => {
    const capped = capTtsText("Sentence one. ".repeat(200));
    expect(capped.length).toBeLessThanOrEqual(MAX_TTS_CHARS);
    expect(capped.endsWith(".")).toBe(true);
  });

  it("hard-cuts long text with no sentence end", () => {
    expect(capTtsText("x".repeat(MAX_TTS_CHARS + 5)).length).toBe(MAX_TTS_CHARS);
  });

  it("splits into chunks under the limit without losing words", () => {
    const text = `Short one. ${"word ".repeat(200)}End here. Last one!`;
    const chunks = splitTtsChunks(text.trim(), 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join(" ").split(/\s+/).length).toBe(text.trim().split(/\s+/).length);
  });
});
