import GraphicEqIcon from "@mui/icons-material/GraphicEq";
import MicIcon from "@mui/icons-material/Mic";
import StopIcon from "@mui/icons-material/Stop";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import { Alert, IconButton, Tooltip } from "@mui/material";
import type { SpeechStatus } from "@triplanner/shared";
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { api, errorText } from "../api";
import { canDecodeAudio, microphoneErrorText, microphoneProblem, toWavBlob } from "../lib/audio";

export const STATUS_POLL_MS = 3_000;
const STATUS_RETRY_MS = 15_000;

export interface VoiceState {
  speech: SpeechStatus | null;
  checkError: string | null;
}

/** Polls while a model downloads, and slowly after a failed check. Never throws. */
export const useSpeechStatus = (): VoiceState => {
  const [state, setState] = useState<VoiceState>({ speech: null, checkError: null });

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const speech = await api.speechStatus();
        if (!active) return;
        setState({ speech, checkError: null });
        if (speech.stt.status === "downloading" || speech.tts.status === "downloading") {
          timer = setTimeout(() => void check(), STATUS_POLL_MS);
        }
      } catch (cause) {
        if (!active) return;
        setState({ speech: null, checkError: errorText(cause) });
        timer = setTimeout(() => void check(), STATUS_RETRY_MS);
      }
    };
    void check();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  return state;
};

const featureProblem = (
  { speech, checkError }: VoiceState,
  feature: "stt" | "tts",
  name: string,
): string | null => {
  if (checkError) return `Voice status is unavailable: ${checkError}`;
  if (!speech) return "Checking voice availability...";
  const { status, reason } = speech[feature];
  if (status === "ready") return null;
  if (status === "downloading") {
    return reason ?? `The ${name} model is still downloading.`;
  }
  return reason ?? `${name} is unavailable.`;
};

/** MUI needs the span: a disabled button fires no events, so its tooltip would never open. */
function VoiceButton({
  label,
  problem,
  disabled,
  onClick,
  children,
}: {
  label: string;
  problem: string | null;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip title={problem ?? label}>
      <span>
        <IconButton
          size="small"
          aria-label={label}
          disabled={problem !== null || disabled}
          onClick={onClick}
        >
          {children}
        </IconButton>
      </span>
    </Tooltip>
  );
}

/** Mic and audio upload. Both lead to the same transcription path and hand text to `onText`. */
export function VoiceInput({ voice, onText }: { voice: VoiceState; onText: (t: string) => void }) {
  const [micProblem, setMicProblem] = useState<string | null>("Checking for a microphone...");
  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing">("idle");
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void microphoneProblem().then((problem) => {
      if (active) setMicProblem(problem);
    });
    return () => {
      active = false;
    };
  }, []);

  const stopTracks = useCallback(() => {
    try {
      stream.current?.getTracks().forEach((track) => track.stop());
    } catch {
      // Nothing to release.
    }
    stream.current = null;
  }, []);

  useEffect(
    () => () => {
      try {
        if (recorder.current?.state === "recording") {
          recorder.current.onstop = null;
          recorder.current.stop();
        }
      } catch {
        // Already stopped.
      }
      stopTracks();
    },
    [stopTracks],
  );

  const transcribe = useCallback(
    async (audio: Blob) => {
      setPhase("transcribing");
      setError(null);
      try {
        const text = (await api.transcribe(await toWavBlob(audio))).trim();
        if (text) onText(text);
        else setError("No speech was recognized in that audio.");
      } catch (cause) {
        setError(errorText(cause));
      } finally {
        setPhase("idle");
      }
    },
    [onText],
  );

  const startRecording = async () => {
    setError(null);
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      const media = new MediaRecorder(stream.current);
      const chunks: Blob[] = [];
      media.ondataavailable = (event) => chunks.push(event.data);
      media.onerror = () => {
        stopTracks();
        setPhase("idle");
        setError("Recording failed.");
      };
      media.onstop = () => {
        stopTracks();
        void transcribe(new Blob(chunks, { type: media.mimeType }));
      };
      recorder.current = media;
      media.start();
      setPhase("recording");
    } catch (cause) {
      stopTracks();
      setPhase("idle");
      setError(microphoneErrorText(cause));
    }
  };

  const stopRecording = () => {
    try {
      recorder.current?.stop();
    } catch (cause) {
      stopTracks();
      setPhase("idle");
      setError(microphoneErrorText(cause));
    }
  };

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void transcribe(file);
  };

  const sttProblem = featureProblem(voice, "stt", "Speech to text");
  const uploadProblem =
    sttProblem ?? (canDecodeAudio() ? null : "This browser cannot decode audio.");
  const recordProblem = sttProblem ?? micProblem;

  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 2 }}>
      {phase === "recording" ? (
        <VoiceButton label="Stop recording" problem={null} onClick={stopRecording}>
          <StopIcon fontSize="small" color="secondary" />
        </VoiceButton>
      ) : (
        <VoiceButton
          label="Record with microphone"
          problem={recordProblem}
          disabled={phase !== "idle"}
          onClick={() => void startRecording()}
        >
          <MicIcon fontSize="small" />
        </VoiceButton>
      )}
      <VoiceButton
        label="Upload audio file"
        problem={uploadProblem}
        disabled={phase !== "idle"}
        onClick={() => uploadRef.current?.click()}
      >
        <UploadFileIcon fontSize="small" />
      </VoiceButton>
      <input
        ref={uploadRef}
        className="visually-hidden"
        type="file"
        accept="audio/*"
        aria-label="Audio file to transcribe"
        tabIndex={-1}
        disabled={uploadProblem !== null || phase !== "idle"}
        onChange={onFile}
      />
      {phase === "recording" && (
        <span role="status" className="eyebrow">
          Recording...
        </span>
      )}
      {phase === "transcribing" && (
        <span role="status" className="eyebrow">
          Transcribing...
        </span>
      )}
      {error && (
        <Alert severity="error" sx={{ py: 0 }}>
          {error}
        </Alert>
      )}
    </div>
  );
}

export function ReadAloud({ voice, text }: { voice: VoiceState; text: string }) {
  const [phase, setPhase] = useState<"idle" | "loading" | "playing">("idle");
  const [error, setError] = useState<string | null>(null);
  const player = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);

  const release = useCallback(() => {
    const current = player.current;
    player.current = null;
    if (!current) return;
    try {
      current.audio.pause();
      URL.revokeObjectURL(current.url);
    } catch {
      // Already released.
    }
  }, []);

  useEffect(() => release, [release]);

  const play = async () => {
    setError(null);
    setPhase("loading");
    try {
      const blob = await api.tts(text);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      player.current = { audio, url };
      audio.onended = () => {
        release();
        setPhase("idle");
      };
      audio.onerror = () => {
        release();
        setPhase("idle");
        setError("Could not play the audio.");
      };
      await audio.play();
      setPhase("playing");
    } catch (cause) {
      release();
      setPhase("idle");
      setError(`Could not read this aloud: ${errorText(cause)}`);
    }
  };

  const problem = featureProblem(voice, "tts", "Text to speech");

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {phase === "playing" ? (
        <VoiceButton
          label="Stop reading"
          problem={null}
          onClick={() => {
            release();
            setPhase("idle");
          }}
        >
          <GraphicEqIcon fontSize="small" color="secondary" />
        </VoiceButton>
      ) : (
        <VoiceButton
          label="Read aloud"
          problem={problem}
          disabled={phase === "loading"}
          onClick={() => void play()}
        >
          <VolumeUpIcon fontSize="small" />
        </VoiceButton>
      )}
      {phase === "loading" && (
        <span role="status" className="eyebrow">
          Preparing audio...
        </span>
      )}
      {error && (
        <Alert severity="error" sx={{ py: 0 }}>
          {error}
        </Alert>
      )}
    </div>
  );
}
