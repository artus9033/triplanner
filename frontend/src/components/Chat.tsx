import { Alert, Button, TextField, Typography } from "@mui/material";
import type { ChatMessage, Trip } from "@triplanner/shared";
import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { emptyChat, useTripStore } from "../store";
import { Slogan } from "./Slogan";
import { ReadAloud, useSpeechStatus, VoiceInput, type VoiceState } from "./Voice";

const timeOf = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
};

function Entry({ message, voice }: { message: ChatMessage; voice: VoiceState }) {
  const fromUser = message.role === "user";
  return (
    <div className={fromUser ? "entry entry--user" : "entry"}>
      <div className="entry__who eyebrow">
        {fromUser ? "You" : "Planner"}
        <br />
        {timeOf(message.createdAt)}
      </div>
      <div>
        <div className="entry__text plain-text">{message.content}</div>
        {!fromUser && <ReadAloud voice={voice} text={message.content} />}
      </div>
    </div>
  );
}

export function Chat({ trip }: { trip: Trip }) {
  const chat = useTripStore((s) => s.chats[trip.id]) ?? emptyChat;
  const setDraft = useTripStore((s) => s.setDraft);
  const sendMessage = useTripStore((s) => s.sendMessage);
  const voice = useSpeechStatus();
  const logRef = useRef<HTMLDivElement>(null);

  const open = trip.step === "intake";
  const sending = chat.pending !== null;
  const canSend = chat.draft.trim().length > 0 && !sending;
  const hasUserMessage = trip.messages.some((message) => message.role === "user");

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [trip.messages.length, chat.pending]);

  const send = () => {
    if (canSend) void sendMessage(trip.id, chat.draft.trim());
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const onTranscript = useCallback(
    (text: string) => {
      const current = useTripStore.getState().chats[trip.id]?.draft ?? "";
      setDraft(trip.id, current ? `${current} ${text}` : text);
    },
    [setDraft, trip.id],
  );

  return (
    <section className="chat" aria-label="Trip intake chat">
      {!hasUserMessage && !sending && <Slogan />}
      <div ref={logRef} className="log" role="log" aria-label="Conversation" aria-live="polite">
        {trip.messages.map((message) => (
          <Entry key={message.id} message={message} voice={voice} />
        ))}
        {sending && (
          <>
            <div className="entry entry--user">
              <div className="entry__who eyebrow">You</div>
              <div className="entry__text plain-text">{chat.pending}</div>
            </div>
            <div className="entry" role="status">
              <div className="entry__who eyebrow">Planner</div>
              <div className="thinking">Thinking</div>
            </div>
          </>
        )}
      </div>
      {chat.error && (
        <Alert severity="error" sx={{ my: 1 }}>
          Your message was not sent: {chat.error}
        </Alert>
      )}
      {open ? (
        <div className="composer">
          <TextField
            label="Your answer"
            multiline
            minRows={2}
            maxRows={8}
            fullWidth
            variant="standard"
            value={chat.draft}
            onChange={(event) => setDraft(trip.id, event.target.value)}
            onKeyDown={onKeyDown}
            helperText="Enter sends. Shift+Enter starts a new line."
            slotProps={{ htmlInput: { "data-testid": "chat-input" } }}
          />
          <div className="composer__row">
            <VoiceInput voice={voice} onText={onTranscript} />
            <Button data-testid="chat-send" variant="contained" disabled={!canSend} onClick={send}>
              {sending ? "Sending..." : "Send"}
            </Button>
          </div>
        </div>
      ) : (
        <Typography color="text.secondary" sx={{ pt: 1 }}>
          Intake is finished, so this conversation is read-only.
        </Typography>
      )}
    </section>
  );
}
