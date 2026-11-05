import type { SpeechStatus } from "@triplanner/shared";
import { loadKokoro, loadWhisper } from "./models";
import { createSpeechService } from "./service";

export { MAX_STT_MINUTES, MAX_TTS_CHARS } from "./service";
export { modelsDir, speechModelsCached } from "./models";

// The model libraries are imported inside the loaders, so importing this module stays cheap.
const service = createSpeechService({ loadStt: loadWhisper, loadTts: loadKokoro });

/** Also starts background model downloads the first time it is called. Never throws. */
export function speechStatus(): SpeechStatus {
  return service.speechStatus();
}

/** Speech to text. Takes WAV natively, and other formats when ffmpeg is on PATH. */
export function transcribe(audio: Buffer, mime: string): Promise<string> {
  return service.transcribe(audio, mime);
}

/** Text to speech. Returns 16-bit PCM WAV bytes; text past MAX_TTS_CHARS is cut. */
export function synthesize(text: string): Promise<Buffer> {
  return service.synthesize(text);
}
