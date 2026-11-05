import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { modelsDir, speechModelsCached, speechStatus, synthesize, transcribe } from "./index";
import { parseWav } from "./wav";

const LIVE_TIMEOUT_MS = 15 * 60_000;

describe.skipIf(process.env.SKIP_SPEECH_LIVE === "1")("speech round trip (real models)", () => {
  it(
    "reads a sentence aloud and transcribes it back",
    async () => {
      const first = speechStatus();
      expect(["ready", "downloading"]).toContain(first.tts.status);

      const startedTts = performance.now();
      const wav = await synthesize("The Louvre opens at nine in the morning");
      const ttsMs = performance.now() - startedTts;
      const { sampleRate, channels, samples } = parseWav(wav);
      expect(channels).toBe(1);
      expect(sampleRate).toBe(24_000);
      expect(samples.length / sampleRate).toBeGreaterThan(1);

      const startedStt = performance.now();
      const text = (await transcribe(wav, "audio/wav")).toLowerCase();
      const sttMs = performance.now() - startedStt;
      console.info(
        `speech round trip: tts ${Math.round(ttsMs)} ms, stt ${Math.round(sttMs)} ms, heard "${text}"`,
      );
      expect(text.includes("louvre") || text.includes("nine") || text.includes("9")).toBe(true);

      expect(speechStatus()).toEqual({
        stt: { status: "ready", reason: null },
        tts: { status: "ready", reason: null },
      });
      expect(speechModelsCached()).toEqual({ stt: true, tts: true });
      expect(existsSync(path.join(modelsDir(), "onnx-community"))).toBe(true);
      expect(readdirSync(path.join(modelsDir(), "onnx-community")).length).toBe(2);
    },
    LIVE_TIMEOUT_MS,
  );
});
