export const TARGET_SAMPLE_RATE = 16_000;

type DecodingContext = Pick<BaseAudioContext, "decodeAudioData"> & { close?: () => Promise<void> };

/** Encodes mono float samples as 16-bit PCM WAV. */
export const encodeWav = (samples: Float32Array, sampleRate: number): ArrayBuffer => {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  });
  return buffer;
};

export const mixToMono = (decoded: AudioBuffer): Float32Array => {
  const mono = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const data = decoded.getChannelData(channel);
    for (let i = 0; i < mono.length; i++) mono[i]! += data[i]! / decoded.numberOfChannels;
  }
  return mono;
};

/** An offline context needs no output device, which the VM does not have. */
const createDecodingContext = (): DecodingContext | null => {
  if (typeof OfflineAudioContext !== "undefined") {
    return new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);
  }
  if (typeof AudioContext !== "undefined") {
    return new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  }
  return null;
};

export const canDecodeAudio = (): boolean =>
  typeof OfflineAudioContext !== "undefined" || typeof AudioContext !== "undefined";

/** decodeAudioData resamples to the context's rate, so the output is always 16 kHz. */
export const toWavBlob = async (input: Blob): Promise<Blob> => {
  const context = createDecodingContext();
  if (!context) throw new Error("This browser cannot decode audio.");
  try {
    const decoded = await context.decodeAudioData(await input.arrayBuffer());
    return new Blob([encodeWav(mixToMono(decoded), TARGET_SAMPLE_RATE)], { type: "audio/wav" });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Could not decode this audio: ${detail}`);
  } finally {
    await context.close?.().catch(() => undefined);
  }
};

/** Why the microphone cannot be used, or null when it can. Never throws. */
export const microphoneProblem = async (): Promise<string | null> => {
  try {
    const devices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (!devices || typeof devices.getUserMedia !== "function") {
      return "Microphone access is not available here (it needs HTTPS or localhost).";
    }
    if (typeof MediaRecorder === "undefined") return "This browser cannot record audio.";
    if (!canDecodeAudio()) return "This browser cannot decode audio.";
    if (typeof devices.enumerateDevices === "function") {
      const list = await devices.enumerateDevices();
      if (!list.some((device) => device.kind === "audioinput")) return "No microphone found.";
    }
    return null;
  } catch {
    return "Could not check for a microphone.";
  }
};

export const microphoneErrorText = (cause: unknown): string => {
  const name = cause instanceof Error ? cause.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone permission was denied.";
  }
  if (name === "NotFoundError") return "No microphone found.";
  if (name === "NotReadableError") return "The microphone is in use or not readable.";
  return `Could not record: ${cause instanceof Error ? cause.message : String(cause)}`;
};
