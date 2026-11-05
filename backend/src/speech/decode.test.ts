import { describe, expect, it, vi } from "vitest";
import { decodeAudio } from "./decode";
import { encodeWav } from "./wav";

describe("decodeAudio", () => {
  it("decodes WAV without touching ffmpeg", async () => {
    const ffmpeg = vi.fn();
    const out = await decodeAudio(
      encodeWav(new Float32Array(16_000).fill(0.5), 16_000),
      "audio/wav",
      ffmpeg,
    );
    expect(out.length).toBe(16_000);
    expect(ffmpeg).not.toHaveBeenCalled();
  });

  it("names the problem for non-WAV audio without ffmpeg", async () => {
    await expect(
      decodeAudio(Buffer.from("OggS...."), "audio/ogg", async () => null),
    ).rejects.toThrow(/Cannot decode audio\/ogg.*Only WAV.*ffmpeg is not installed/);
  });

  it("reports undecodable audio as a client error with on-screen text", async () => {
    const failing = async () =>
      Promise.reject(new Error("Could not decode the audio with ffmpeg: bad data"));
    await expect(decodeAudio(Buffer.from("junk"), "audio/x", failing)).rejects.toMatchObject({
      status: 400,
      userMessage: "Could not decode the audio with ffmpeg: bad data",
    });
    await expect(
      decodeAudio(Buffer.from("OggS"), "audio/ogg", async () => null),
    ).rejects.toMatchObject({ status: 415 });
  });

  it("uses ffmpeg for other formats when it is there", async () => {
    const samples = new Float32Array([0.1]);
    await expect(
      decodeAudio(Buffer.from("OggS...."), "audio/ogg", async () => samples),
    ).resolves.toBe(samples);
  });

  it("rejects empty input and audio with no samples", async () => {
    await expect(decodeAudio(Buffer.alloc(0), "audio/wav")).rejects.toThrow(/empty/);
    await expect(decodeAudio(encodeWav(new Float32Array(0), 16_000), "audio/wav")).rejects.toThrow(
      /no samples/,
    );
  });
});
