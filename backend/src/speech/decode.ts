import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SpeechError } from "./errors";
import { isWav, STT_SAMPLE_RATE, UnsupportedWavCodecError, wavToWhisperInput } from "./wav";

const FFMPEG_TIMEOUT_MS = 60_000;
/** Real audio containers only, so an uploaded playlist cannot make ffmpeg read other files. */
const FFMPEG_FORMATS = "wav,mp3,ogg,flac,aac,matroska,webm,mov,mp4,m4a,3gp,asf";

export const NO_FFMPEG_MESSAGE =
  "Only WAV audio can be transcribed here because ffmpeg is not installed. Convert the file to WAV, or install ffmpeg.";

/** Runs ffmpeg on the input and returns raw float samples; null when ffmpeg is not installed. */
export const ffmpegDecode = async (data: Buffer): Promise<Float32Array | null> => {
  const dir = await mkdtemp(path.join(tmpdir(), "triplanner-audio-"));
  try {
    // A real file rather than a pipe, because MP4/M4A needs seeking.
    const input = path.join(dir, "input");
    await writeFile(input, data);
    return await new Promise<Float32Array | null>((resolve, reject) => {
      const child = spawn(
        "ffmpeg",
        // prettier-ignore
        [
          "-nostdin", "-hide_banner", "-loglevel", "error",
          "-format_whitelist", FFMPEG_FORMATS, "-protocol_whitelist", "file",
          "-i", input,
          "-vn", "-ac", "1", "-ar", String(STT_SAMPLE_RATE), "-f", "f32le", "pipe:1",
        ],
        { stdio: ["ignore", "pipe", "pipe"], timeout: FFMPEG_TIMEOUT_MS },
      );
      const out: Buffer[] = [];
      let err = "";
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
      child.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") resolve(null);
        else reject(e);
      });
      child.on("close", (code) => {
        if (code !== 0) {
          const detail = err.trim().split("\n").pop()?.replaceAll(dir, "") ?? "";
          return reject(
            new Error(`Could not decode the audio with ffmpeg: ${detail || `exit ${code}`}`),
          );
        }
        const pcm = Buffer.concat(out);
        const samples = new Float32Array(Math.floor(pcm.length / 4));
        for (let i = 0; i < samples.length; i++) samples[i] = pcm.readFloatLE(i * 4);
        resolve(samples);
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const decode = async (
  data: Buffer,
  mime: string,
  ffmpeg: (data: Buffer) => Promise<Float32Array | null>,
): Promise<Float32Array> => {
  if (!isWav(data)) {
    const samples = await ffmpeg(data);
    if (samples === null) {
      throw new SpeechError(415, `Cannot decode ${mime || "this audio"}. ${NO_FFMPEG_MESSAGE}`);
    }
    return samples;
  }
  try {
    return wavToWhisperInput(data);
  } catch (e) {
    if (!(e instanceof UnsupportedWavCodecError)) throw e;
    const samples = await ffmpeg(data);
    if (samples === null) throw new SpeechError(415, `${e.message}. ${NO_FFMPEG_MESSAGE}`);
    return samples;
  }
};

/** Decodes uploaded audio to 16 kHz mono. WAV needs nothing external; the rest needs ffmpeg. */
export const decodeAudio = async (
  data: Buffer,
  mime: string,
  ffmpeg: (data: Buffer) => Promise<Float32Array | null> = ffmpegDecode,
): Promise<Float32Array> => {
  if (data.length === 0) throw new SpeechError(400, "The audio is empty");
  let samples: Float32Array;
  try {
    samples = await decode(data, mime, ffmpeg);
  } catch (e) {
    if (e instanceof SpeechError) throw e;
    throw new SpeechError(400, e instanceof Error ? e.message : String(e));
  }
  if (samples.length === 0) throw new SpeechError(400, "The audio contains no samples");
  return samples;
};
