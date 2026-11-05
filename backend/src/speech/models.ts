import { existsSync } from "node:fs";
import path from "node:path";
import { toolsDir } from "../config/env";
import type { Progress, SttEngine, TtsEngine } from "./service";

/*
 * Version note: backend's @huggingface/transformers must stay on the same major as the one kokoro-js
 * depends on (3.x), so pnpm installs a single copy. Two copies load two onnxruntime-node native
 * bindings into one process, and they collide: inference fails with "Preferred output locations must
 * have the same size as output names".
 */
export const STT_MODEL = "onnx-community/whisper-tiny.en";
export const TTS_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const TTS_VOICE = "af_heart";

export const modelsDir = (): string => path.join(toolsDir(), "models");

/** The files whose presence means a model was fully downloaded. The cache writes each atomically. */
const STT_FILES = ["onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"];
const TTS_FILES = ["onnx/model_quantized.onnx"];

const cached = (model: string, files: string[]): boolean =>
  files.every((file) => existsSync(path.join(modelsDir(), model, file)));

/** Reads the disk only: never loads a library or starts a download. */
export const speechModelsCached = (): { stt: boolean; tts: boolean } => ({
  stt: cached(STT_MODEL, STT_FILES),
  tts: cached(TTS_MODEL, TTS_FILES),
});

type ProgressEvent = { status?: string; file?: string; loaded?: number; total?: number };

/** Folds per-file progress events into overall downloaded bytes across the files seen so far. */
const progressReporter = (onProgress: Progress) => {
  const files = new Map<string, { loaded: number; total: number }>();
  return (event: ProgressEvent): void => {
    if (event.status !== "progress" || !event.file || !event.total) return;
    files.set(event.file, { loaded: event.loaded ?? 0, total: event.total });
    let loaded = 0;
    let total = 0;
    for (const file of files.values()) {
      loaded += file.loaded;
      total += file.total;
    }
    onProgress({ loaded, total });
  };
};

export const loadWhisper = async (onProgress: Progress): Promise<SttEngine> => {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = modelsDir();
  const recognize = await pipeline("automatic-speech-recognition", STT_MODEL, {
    device: "cpu",
    dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
    progress_callback: progressReporter(onProgress),
  });
  return {
    transcribe: async (samples) => {
      const result = await recognize(samples, { chunk_length_s: 30, stride_length_s: 5 });
      const output = Array.isArray(result) ? result[0] : result;
      return output?.text.trim() ?? "";
    },
  };
};

export const loadKokoro = async (onProgress: Progress): Promise<TtsEngine> => {
  // kokoro-js has no cache option. It shares this transformers.js instance (see the version note above).
  const { env } = await import("@huggingface/transformers");
  env.cacheDir = modelsDir();
  const { KokoroTTS } = await import("kokoro-js");
  const tts = await KokoroTTS.from_pretrained(TTS_MODEL, {
    dtype: "q8",
    device: "cpu",
    progress_callback: progressReporter(onProgress),
  });
  return {
    synthesize: async (text) => {
      const audio = await tts.generate(text, { voice: TTS_VOICE });
      return { samples: audio.audio, sampleRate: audio.sampling_rate };
    },
  };
};
