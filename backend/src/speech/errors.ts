/** A speech failure whose message is safe to show on screen. The API error handler reads both fields. */
export class SpeechError extends Error {
  readonly status: number;
  readonly userMessage: string;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.userMessage = message;
  }
}
