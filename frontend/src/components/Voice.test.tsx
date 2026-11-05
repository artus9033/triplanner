import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, stubFetch } from "../test/fixtures";
import { renderUi } from "../test/render";
import { ReadAloud, STATUS_POLL_MS, useSpeechStatus, VoiceInput } from "./Voice";

const ready = { status: "ready", reason: null };
const speechReady = { stt: ready, tts: ready };

const Harness = ({ onText = () => undefined }: { onText?: (t: string) => void }) => {
  const voice = useSpeechStatus();
  return (
    <>
      <VoiceInput voice={voice} onText={onText} />
      <ReadAloud voice={voice} text="Hello there" />
    </>
  );
};

const stubDevices = (kinds: string[], getUserMedia: () => Promise<unknown> = vi.fn()) => {
  vi.stubGlobal("navigator", {
    ...navigator,
    mediaDevices: {
      getUserMedia,
      enumerateDevices: async () => kinds.map((kind) => ({ kind })),
    },
  });
  vi.stubGlobal("MediaRecorder", class {});
  vi.stubGlobal(
    "OfflineAudioContext",
    class {
      decodeAudioData = async () => ({
        length: 2,
        numberOfChannels: 1,
        getChannelData: () => new Float32Array([0, 0.5]),
      });
    },
  );
};

const mic = () => screen.getByRole("button", { name: "Record with microphone", hidden: true });
const upload = () => screen.getByRole("button", { name: "Upload audio file", hidden: true });
const speak = () => screen.getByRole("button", { name: "Read aloud", hidden: true });

const expectTooltip = async (button: HTMLElement, text: RegExp) => {
  const user = userEvent.setup();
  await user.hover(button.parentElement!);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(text);
  await user.unhover(button.parentElement!);
};

beforeEach(() => stubDevices(["audioinput"]));

describe("voice controls", () => {
  it("are enabled when the models and a microphone are ready", async () => {
    stubFetch({ "GET /api/speech/status": jsonResponse(speechReady) });
    renderUi(<Harness />);
    await waitFor(() => expect(mic()).toBeEnabled());
    expect(upload()).toBeEnabled();
    expect(speak()).toBeEnabled();
  });

  it("disable with a reason when the browser has no mediaDevices", async () => {
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: undefined });
    stubFetch({ "GET /api/speech/status": jsonResponse(speechReady) });
    renderUi(<Harness />);
    await waitFor(() => expect(upload()).toBeEnabled());
    expect(mic()).toBeDisabled();
    await expectTooltip(mic(), /not available here/);
  });

  it("disable the mic, but not upload, when no input device exists", async () => {
    stubDevices(["audiooutput"]);
    stubFetch({ "GET /api/speech/status": jsonResponse(speechReady) });
    renderUi(<Harness />);
    await waitFor(() => expect(upload()).toBeEnabled());
    expect(mic()).toBeDisabled();
    await expectTooltip(mic(), /No microphone found/);
  });

  it("disable with a reason when AudioContext is missing", async () => {
    vi.stubGlobal("OfflineAudioContext", undefined);
    vi.stubGlobal("AudioContext", undefined);
    stubFetch({ "GET /api/speech/status": jsonResponse(speechReady) });
    renderUi(<Harness />);
    await waitFor(() => expect(speak()).toBeEnabled());
    expect(mic()).toBeDisabled();
    expect(upload()).toBeDisabled();
    await expectTooltip(upload(), /cannot decode/);
  });

  it("while a model downloads: disabled with the reason, and polling until ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let status: unknown = {
      stt: { status: "downloading", reason: "Downloading the Whisper model" },
      tts: { status: "downloading", reason: null },
    };
    const { calls } = stubFetch({ "GET /api/speech/status": () => jsonResponse(status) });
    renderUi(<Harness />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() =>
      expect(mic().parentElement).toHaveAttribute("aria-label", "Downloading the Whisper model"),
    );
    expect(mic()).toBeDisabled();
    expect(upload()).toBeDisabled();
    expect(speak()).toBeDisabled();
    expect(speak().parentElement).toHaveAttribute(
      "aria-label",
      "The Text to speech model is still downloading.",
    );

    status = speechReady;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    });
    await waitFor(() => expect(speak()).toBeEnabled());
    const count = calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 3);
    });
    expect(calls).toHaveLength(count);
  });

  it("disable with the server's reason when unavailable", async () => {
    const off = { status: "unavailable", reason: "Models cannot be downloaded here" };
    stubFetch({ "GET /api/speech/status": jsonResponse({ stt: off, tts: off }) });
    renderUi(<Harness />);
    await waitFor(() => expect(speak().parentElement).toHaveAttribute("aria-label", off.reason));
    expect(upload()).toBeDisabled();
  });

  it("disable with a reason, without throwing, when the status call fails", async () => {
    stubFetch({ "GET /api/speech/status": jsonResponse({ error: "Backend down" }, 500) });
    renderUi(<Harness />);
    await waitFor(() =>
      expect(speak().parentElement).toHaveAttribute(
        "aria-label",
        "Voice status is unavailable: Backend down",
      ),
    );
    expect(mic()).toBeDisabled();
  });

  it("shows text, without throwing, when getUserMedia is refused", async () => {
    const user = userEvent.setup();
    stubDevices(["audioinput"], () =>
      Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" })),
    );
    stubFetch({ "GET /api/speech/status": jsonResponse(speechReady) });
    renderUi(<Harness />);
    await waitFor(() => expect(mic()).toBeEnabled());
    await user.click(mic());
    expect(await screen.findByText("Microphone permission was denied.")).toBeInTheDocument();
    expect(mic()).toBeEnabled();
  });

  it("transcribes an uploaded file as a WAV and hands over the text", async () => {
    const user = userEvent.setup();
    const onText = vi.fn();
    const { calls } = stubFetch({
      "GET /api/speech/status": jsonResponse(speechReady),
      "POST /api/speech/transcribe": jsonResponse({ text: " Paris in May " }),
    });
    renderUi(<Harness onText={onText} />);
    await waitFor(() => expect(upload()).toBeEnabled());
    await user.upload(
      screen.getByLabelText("Audio file to transcribe"),
      new File(["fake"], "voice.mp3", { type: "audio/mpeg" }),
    );
    await waitFor(() => expect(onText).toHaveBeenCalledWith("Paris in May"));
    const body = calls.find((c) => c.method === "POST")?.body as Blob;
    expect(body.type).toBe("audio/wav");
    expect(body.size).toBe(44 + 4);
  });

  it("shows text when transcription fails or finds no speech", async () => {
    const user = userEvent.setup();
    const onText = vi.fn();
    let response = jsonResponse({ error: "Whisper failed" }, 500);
    stubFetch({
      "GET /api/speech/status": jsonResponse(speechReady),
      "POST /api/speech/transcribe": () => response,
    });
    renderUi(<Harness onText={onText} />);
    await waitFor(() => expect(upload()).toBeEnabled());
    const file = new File(["fake"], "voice.wav", { type: "audio/wav" });
    await user.upload(screen.getByLabelText("Audio file to transcribe"), file);
    expect(await screen.findByText("Whisper failed")).toBeInTheDocument();

    response = jsonResponse({ text: "  " });
    await waitFor(() => expect(upload()).toBeEnabled());
    await user.upload(screen.getByLabelText("Audio file to transcribe"), file);
    expect(await screen.findByText(/No speech was recognized/)).toBeInTheDocument();
    expect(onText).not.toHaveBeenCalled();
  });

  it("read aloud posts the text and plays the returned audio", async () => {
    const user = userEvent.setup();
    const play = vi.fn(async () => undefined);
    vi.stubGlobal(
      "Audio",
      class {
        play = play;
        pause = vi.fn();
      },
    );
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const { calls } = stubFetch({
      "GET /api/speech/status": jsonResponse(speechReady),
      "POST /api/speech/tts": new Response(new Blob(["wav"], { type: "audio/wav" })),
    });
    renderUi(<Harness />);
    await waitFor(() => expect(speak()).toBeEnabled());
    await user.click(speak());
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ text: "Hello there" });
    expect(await screen.findByRole("button", { name: "Stop reading" })).toBeInTheDocument();
  });

  it("read aloud shows text, without throwing, when playback is impossible", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "Audio",
      class {
        play = () => Promise.reject(new Error("no output device"));
        pause = vi.fn();
      },
    );
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    stubFetch({
      "GET /api/speech/status": jsonResponse(speechReady),
      "POST /api/speech/tts": new Response(new Blob(["wav"])),
    });
    renderUi(<Harness />);
    await waitFor(() => expect(speak()).toBeEnabled());
    await user.click(speak());
    expect(
      await screen.findByText(/Could not read this aloud: no output device/),
    ).toBeInTheDocument();
    expect(speak()).toBeEnabled();
  });
});
