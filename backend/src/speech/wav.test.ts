import { describe, expect, it } from "vitest";
import {
  encodeWav,
  isWav,
  parseWav,
  resample,
  toMono,
  UnsupportedWavCodecError,
  wavToWhisperInput,
} from "./wav";

/** Builds a WAV with an optional extra chunk before the data, as many encoders write. */
const wav = (opts: {
  code?: number;
  channels?: number;
  rate?: number;
  bits: number;
  body: Buffer;
  extra?: boolean;
  sizeOverride?: number;
}) => {
  const { code = 1, channels = 1, rate = 16_000, bits, body, extra, sizeOverride } = opts;
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "latin1");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(code, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE((rate * channels * bits) / 8, 16);
  fmt.writeUInt16LE((channels * bits) / 8, 20);
  fmt.writeUInt16LE(bits, 22);
  const list = extra
    ? Buffer.concat([
        Buffer.from("LIST", "latin1"),
        Buffer.from([3, 0, 0, 0]),
        Buffer.from("abc\0", "latin1"),
      ])
    : Buffer.alloc(0);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0, "latin1");
  dataHeader.writeUInt32LE(sizeOverride ?? body.length, 4);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "latin1");
  riff.write("WAVE", 8, "latin1");
  return Buffer.concat([riff, fmt, list, dataHeader, body]);
};

const int16 = (...values: number[]) => {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeInt16LE(v, i * 2));
  return b;
};

describe("parseWav", () => {
  it("reads 16-bit PCM", () => {
    const { samples, sampleRate, channels } = parseWav(
      wav({ bits: 16, body: int16(0, 16_384, -32_768) }),
    );
    expect(sampleRate).toBe(16_000);
    expect(channels).toBe(1);
    expect([...samples]).toEqual([0, 0.5, -1]);
  });

  it("reads 32-bit float", () => {
    const body = Buffer.alloc(8);
    body.writeFloatLE(0.25, 0);
    body.writeFloatLE(-0.5, 4);
    expect([...parseWav(wav({ code: 3, bits: 32, body })).samples]).toEqual([0.25, -0.5]);
  });

  it("reads 64-bit float, 8-bit and 24-bit PCM", () => {
    const f64 = Buffer.alloc(8);
    f64.writeDoubleLE(0.5, 0);
    expect(parseWav(wav({ code: 3, bits: 64, body: f64 })).samples[0]).toBe(0.5);
    expect(parseWav(wav({ bits: 8, body: Buffer.from([192]) })).samples[0]).toBe(0.5);
    const i24 = Buffer.alloc(3);
    i24.writeIntLE(4_194_304, 0, 3);
    expect(parseWav(wav({ bits: 24, body: i24 })).samples[0]).toBe(0.5);
  });

  it("skips unknown chunks, including their padding byte", () => {
    expect([...parseWav(wav({ bits: 16, body: int16(16_384), extra: true })).samples]).toEqual([
      0.5,
    ]);
  });

  it("survives a streaming placeholder data size", () => {
    expect(
      parseWav(wav({ bits: 16, body: int16(16_384, 0), sizeOverride: 0xffffffff })).samples.length,
    ).toBe(2);
  });

  it("rejects non-WAV, a missing data chunk, and compressed codecs", () => {
    expect(isWav(Buffer.from("OggS not a wav file"))).toBe(false);
    expect(() => parseWav(Buffer.from("not a wav file at all"))).toThrow(/RIFF/);
    const noData = wav({ bits: 16, body: Buffer.alloc(0) }).subarray(0, 36);
    expect(() => parseWav(noData)).toThrow(/no data chunk/);
    expect(() => parseWav(wav({ code: 2, bits: 4, body: Buffer.alloc(4) }))).toThrow(
      UnsupportedWavCodecError,
    );
  });
});

describe("toMono and resample", () => {
  it("averages channels", () => {
    expect([...toMono(new Float32Array([1, 0, 0.5, 0.5]), 2)]).toEqual([0.5, 0.5]);
  });

  it("keeps the duration when downsampling and upsampling", () => {
    const second = new Float32Array(48_000).fill(0.5);
    const down = resample(second, 48_000, 16_000);
    expect(down.length).toBe(16_000);
    expect(down[100]).toBeCloseTo(0.5);
    const up = resample(new Float32Array(8_000).fill(0.5), 8_000, 16_000);
    expect(up.length).toBe(16_000);
    expect(up[100]).toBeCloseTo(0.5);
  });

  it("interpolates between neighbours when upsampling", () => {
    const up = resample(new Float32Array([0, 1]), 1, 2);
    expect(up[1]).toBeCloseTo(0.5);
  });

  it("returns the input unchanged at the same rate", () => {
    const same = new Float32Array([1, 2]);
    expect(resample(same, 16_000, 16_000)).toBe(same);
  });

  it("turns stereo 44.1 kHz into 16 kHz mono", () => {
    const body = int16(...Array.from({ length: 44_100 * 2 }, () => 16_384));
    const out = wavToWhisperInput(wav({ bits: 16, channels: 2, rate: 44_100, body }));
    expect(out.length).toBe(16_000);
    expect(out[5_000]).toBeCloseTo(0.5);
  });
});

describe("encodeWav", () => {
  it("round-trips through parseWav and clamps out-of-range samples", () => {
    const encoded = encodeWav(new Float32Array([0, 0.5, 2, -2]), 24_000);
    expect(isWav(encoded)).toBe(true);
    const { samples, sampleRate, channels } = parseWav(encoded);
    expect(sampleRate).toBe(24_000);
    expect(channels).toBe(1);
    expect(samples[1]).toBeCloseTo(0.5, 3);
    expect(samples[2]).toBeCloseTo(1, 3);
    expect(samples[3]).toBeCloseTo(-1, 3);
  });
});
