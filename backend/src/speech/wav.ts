/** Dependency-free WAV decoding, encoding and resampling. */

export const STT_SAMPLE_RATE = 16_000;

export type DecodedWav = {
  sampleRate: number;
  channels: number;
  /** Interleaved samples in [-1, 1]. */
  samples: Float32Array;
};

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

export const isWav = (data: Buffer): boolean =>
  data.length >= 12 &&
  data.toString("latin1", 0, 4) === "RIFF" &&
  data.toString("latin1", 8, 12) === "WAVE";

/** Thrown for a RIFF/WAVE file in a codec we do not decode ourselves, such as ADPCM. */
export class UnsupportedWavCodecError extends Error {}

/** Parses PCM (8, 16, 24 or 32 bit) and IEEE float (32 or 64 bit) WAV, at any rate or channel count. */
export const parseWav = (data: Buffer): DecodedWav => {
  if (!isWav(data)) throw new Error("Not a WAV file: the RIFF/WAVE header is missing");

  let format: { code: number; channels: number; sampleRate: number; bits: number } | undefined;
  let body: Buffer | undefined;

  for (let offset = 12; offset + 8 <= data.length;) {
    const id = data.toString("latin1", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || start + size > data.length)
        throw new Error("Invalid WAV: truncated fmt chunk");
      let code = data.readUInt16LE(start);
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in the first two bytes of the sub-format GUID.
      if (code === FORMAT_EXTENSIBLE && size >= 26) code = data.readUInt16LE(start + 24);
      format = {
        code,
        channels: data.readUInt16LE(start + 2),
        sampleRate: data.readUInt32LE(start + 4),
        bits: data.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      // Streaming encoders write a placeholder size, so clamp it to what actually arrived.
      body = data.subarray(start, Math.min(start + size, data.length));
      if (format) break;
    }
    // Chunks are word-aligned.
    offset = start + size + (size % 2);
  }

  if (!format) throw new Error("Invalid WAV: no fmt chunk");
  if (!body) throw new Error("Invalid WAV: no data chunk");
  const { code, channels, sampleRate, bits } = format;
  if (channels < 1 || sampleRate < 1)
    throw new Error("Invalid WAV: bad channel count or sample rate");

  const read = sampleReader(code, bits);
  const width = bits / 8;
  const count = Math.floor(body.length / width);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = read(body, i * width);
  return { sampleRate, channels, samples };
};

const sampleReader = (code: number, bits: number): ((b: Buffer, at: number) => number) => {
  if (code === FORMAT_PCM) {
    if (bits === 8) return (b, at) => (b.readUInt8(at) - 128) / 128;
    if (bits === 16) return (b, at) => b.readInt16LE(at) / 32_768;
    if (bits === 24) return (b, at) => b.readIntLE(at, 3) / 8_388_608;
    if (bits === 32) return (b, at) => b.readInt32LE(at) / 2_147_483_648;
  }
  if (code === FORMAT_FLOAT) {
    if (bits === 32) return (b, at) => b.readFloatLE(at);
    if (bits === 64) return (b, at) => b.readDoubleLE(at);
  }
  throw new UnsupportedWavCodecError(`Unsupported WAV encoding (format ${code}, ${bits} bit)`);
};

export const toMono = (samples: Float32Array, channels: number): Float32Array => {
  if (channels === 1) return samples;
  const frames = Math.floor(samples.length / channels);
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[frame * channels + c] ?? 0;
    mono[frame] = sum / channels;
  }
  return mono;
};

/** Linear interpolation going up; averaging over each output sample's span going down, to limit aliasing. */
export const resample = (samples: Float32Array, from: number, to: number): Float32Array => {
  if (from === to || samples.length === 0) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.max(1, Math.round(samples.length / ratio)));
  if (ratio < 1) {
    for (let i = 0; i < out.length; i++) {
      const position = i * ratio;
      const left = Math.floor(position);
      const a = samples[left] ?? 0;
      const b = samples[left + 1] ?? a;
      out[i] = a + (b - a) * (position - left);
    }
    return out;
  }
  for (let i = 0; i < out.length; i++) {
    const begin = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.max(begin + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = begin; j < end; j++) sum += samples[j] ?? 0;
    out[i] = end > begin ? sum / (end - begin) : 0;
  }
  return out;
};

/** Whatever the WAV's layout, returns the 16 kHz mono floats Whisper expects. */
export const wavToWhisperInput = (data: Buffer): Float32Array => {
  const { samples, channels, sampleRate } = parseWav(data);
  return resample(toMono(samples, channels), sampleRate, STT_SAMPLE_RATE);
};

/** Encodes mono floats as a 16-bit PCM WAV. */
export const encodeWav = (samples: Float32Array, sampleRate: number): Buffer => {
  const header = 44;
  const out = Buffer.alloc(header + samples.length * 2);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVE", 8, "latin1");
  out.write("fmt ", 12, "latin1");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(FORMAT_PCM, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "latin1");
  out.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, i) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    out.writeInt16LE(Math.round(clamped * 32_767), header + i * 2);
  });
  return out;
};
