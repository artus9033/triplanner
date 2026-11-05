import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeWav, microphoneErrorText, microphoneProblem, mixToMono, toWavBlob } from "./audio";

const stubNavigatorDevices = (mediaDevices: unknown) =>
  vi.stubGlobal("navigator", { ...navigator, mediaDevices });

describe("encodeWav", () => {
  it("writes a 16 kHz mono 16-bit header and clamps samples", () => {
    const view = new DataView(encodeWav(new Float32Array([0, 1, -1, 2]), 16_000));
    const ascii = (at: number, n: number) =>
      String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(at + i)));
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
    expect(view.getInt16(50, true)).toBe(32767);
  });
});

describe("mixToMono", () => {
  it("averages the channels", () => {
    const channels = [new Float32Array([1, 0]), new Float32Array([0, 0])];
    const mono = mixToMono({
      length: 2,
      numberOfChannels: 2,
      getChannelData: (i: number) => channels[i],
    } as unknown as AudioBuffer);
    expect(Array.from(mono)).toEqual([0.5, 0]);
  });
});

describe("toWavBlob", () => {
  it("fails with readable text when no decoder exists", async () => {
    vi.stubGlobal("OfflineAudioContext", undefined);
    vi.stubGlobal("AudioContext", undefined);
    await expect(toWavBlob(new Blob(["x"]))).rejects.toThrow("cannot decode");
  });

  it("wraps decode failures in readable text", async () => {
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData = () => Promise.reject(new Error("bad data"));
      },
    );
    await expect(toWavBlob(new Blob(["x"]))).rejects.toThrow(
      "Could not decode this audio: bad data",
    );
  });
});

describe("microphoneProblem", () => {
  afterEach(() => vi.unstubAllGlobals());
  const withRecording = () => {
    vi.stubGlobal("MediaRecorder", class {});
    vi.stubGlobal("OfflineAudioContext", class {});
  };

  it("reports missing mediaDevices", async () => {
    stubNavigatorDevices(undefined);
    expect(await microphoneProblem()).toMatch(/not available/);
  });

  it("reports missing getUserMedia", async () => {
    stubNavigatorDevices({});
    expect(await microphoneProblem()).toMatch(/not available/);
  });

  it("reports a missing MediaRecorder", async () => {
    stubNavigatorDevices({ getUserMedia: vi.fn() });
    vi.stubGlobal("MediaRecorder", undefined);
    expect(await microphoneProblem()).toMatch(/cannot record/);
  });

  it("reports a missing decoder", async () => {
    stubNavigatorDevices({ getUserMedia: vi.fn() });
    vi.stubGlobal("MediaRecorder", class {});
    vi.stubGlobal("OfflineAudioContext", undefined);
    vi.stubGlobal("AudioContext", undefined);
    expect(await microphoneProblem()).toMatch(/cannot decode/);
  });

  it("reports no input device", async () => {
    withRecording();
    stubNavigatorDevices({
      getUserMedia: vi.fn(),
      enumerateDevices: async () => [{ kind: "audiooutput" }],
    });
    expect(await microphoneProblem()).toBe("No microphone found.");
  });

  it("survives enumerateDevices throwing", async () => {
    withRecording();
    stubNavigatorDevices({
      getUserMedia: vi.fn(),
      enumerateDevices: async () => {
        throw new Error("nope");
      },
    });
    expect(await microphoneProblem()).toMatch(/Could not check/);
  });

  it("is null when a microphone exists", async () => {
    withRecording();
    stubNavigatorDevices({
      getUserMedia: vi.fn(),
      enumerateDevices: async () => [{ kind: "audioinput" }],
    });
    expect(await microphoneProblem()).toBeNull();
  });

  it("maps recording errors to text", () => {
    const error = (name: string) => Object.assign(new Error("x"), { name });
    expect(microphoneErrorText(error("NotAllowedError"))).toMatch(/denied/);
    expect(microphoneErrorText(error("NotFoundError"))).toMatch(/No microphone/);
  });
});
