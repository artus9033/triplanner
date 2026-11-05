import type {
  ChatMessage,
  Optimization,
  OptimizationStatus,
  PlaceData,
  PlaceProposal,
  SolverOptions,
  Source,
  SpeechStatus,
  TripPlace,
  TripSchedule,
  TripState,
} from "@triplanner/shared";

export type FeatureCheck = { status: "ready" | "missing" | "degraded"; detail: string };

/** Everything the trip flow and routes need from the LLM, solver and speech modules. */
export interface AppDeps {
  advanceIntake(input: {
    state: TripState;
    messages: ChatMessage[];
    userMessage: string;
    today: string;
  }): Promise<{ state: TripState; reply: string; complete: boolean }>;
  proposePlaces(input: {
    state: TripState;
    messages: ChatMessage[];
    signal?: AbortSignal;
  }): Promise<PlaceProposal[]>;
  researchPlace(input: {
    name: string;
    note: string | null;
    state: TripState;
    signal?: AbortSignal;
  }): Promise<{ data: PlaceData; sources: Source[]; model: string; durationMs: number }>;
  runBotPool<T>(
    items: T[],
    worker: (item: T) => Promise<void>,
    options?: { concurrency?: number },
  ): Promise<void>;
  optimizeTrip(
    input: { state: TripState; places: TripPlace[] },
    options?: SolverOptions & { forcePlaceIds?: string[] },
  ): Promise<{
    status: OptimizationStatus;
    instanceHash: string;
    result: TripSchedule | null;
    error: string | null;
  }>;
  amplStatus(): Promise<{ available: boolean; detail: string }>;
  checkLlmKey(): Promise<FeatureCheck>;
  speechStatus(): SpeechStatus;
  transcribe(audio: Buffer, mime: string): Promise<string>;
  synthesize(text: string): Promise<Buffer>;
}

export type { Optimization };
