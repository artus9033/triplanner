import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { resetTripStore, useTripStore } from "../store";
import { jsonResponse, makeTrip, stubFetch } from "../test/fixtures";
import { renderUi } from "../test/render";
import { Chat } from "./Chat";

const speech = {
  stt: { status: "ready", reason: null },
  tts: { status: "ready", reason: null },
};

const ChatForStore = ({ id = "t1" }: { id?: string }) => {
  const trip = useTripStore((s) => s.trips[id])!;
  return <Chat trip={trip} />;
};

const message = (id: string, role: "user" | "assistant", content: string) => ({
  id,
  role,
  content,
  createdAt: "2026-01-01T10:00:00.000Z",
});

beforeEach(() => {
  resetTripStore();
  useTripStore.getState().applyTrip(makeTrip());
});

describe("Chat", () => {
  it("shows the slogan until the first user message, and the test ids", () => {
    stubFetch({ "GET /api/speech/status": jsonResponse(speech) });
    renderUi(<ChatForStore />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Where do you want");
    expect(screen.getByTestId("chat-input").tagName).toBe("TEXTAREA");
    expect(screen.getByTestId("chat-send")).toBeDisabled();
  });

  it("sends on the button, shows thinking while pending, then the reply", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { calls } = stubFetch({
      "GET /api/speech/status": jsonResponse(speech),
      "POST /api/trips/t1/messages": async () => {
        await gate;
        return jsonResponse(
          makeTrip({
            updatedAt: "2026-02-01T00:00:00.000Z",
            messages: [
              message("1", "user", "Paris in May"),
              message("2", "assistant", "What is your budget?"),
            ],
          }),
        );
      },
    });
    renderUi(<ChatForStore />);
    await user.type(screen.getByTestId("chat-input"), "Paris in May");
    await user.click(screen.getByTestId("chat-send"));

    expect(await screen.findByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText("Paris in May")).toBeInTheDocument();
    expect(screen.getByTestId("chat-input")).toHaveValue("");

    release();
    expect(await screen.findByText("What is your budget?")).toBeInTheDocument();
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ content: "Paris in May" });
  });

  it("Enter sends and Shift+Enter adds a new line", async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({
      "GET /api/speech/status": jsonResponse(speech),
      "POST /api/trips/t1/messages": jsonResponse(makeTrip()),
    });
    renderUi(<ChatForStore />);
    const input = screen.getByTestId("chat-input");
    await user.type(input, "line one{Shift>}{Enter}{/Shift}line two");
    expect(input).toHaveValue("line one\nline two");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        content: "line one\nline two",
      }),
    );
  });

  it("does not send blank input", async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({ "GET /api/speech/status": jsonResponse(speech) });
    renderUi(<ChatForStore />);
    await user.type(screen.getByTestId("chat-input"), "   {Enter}");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("shows the error text and keeps the input on failure", async () => {
    const user = userEvent.setup();
    stubFetch({
      "GET /api/speech/status": jsonResponse(speech),
      "POST /api/trips/t1/messages": jsonResponse({ error: "The model is overloaded." }, 503),
    });
    renderUi(<ChatForStore />);
    await user.type(screen.getByTestId("chat-input"), "Paris{Enter}");
    expect(await screen.findByText(/The model is overloaded\./)).toBeInTheDocument();
    expect(screen.getByTestId("chat-input")).toHaveValue("Paris");
    expect(screen.getByTestId("chat-send")).toBeEnabled();
  });

  it("renders assistant text as plain text", () => {
    stubFetch({ "GET /api/speech/status": jsonResponse(speech) });
    const evil = '<img src=x onerror="alert(1)"> **bold**';
    useTripStore.getState().applyTrip(
      makeTrip({
        updatedAt: "2026-02-01T00:00:00.000Z",
        messages: [message("1", "assistant", evil)],
      }),
    );
    const { container } = renderUi(<ChatForStore />);
    expect(screen.getByText(evil)).toBeInTheDocument();
    expect(container.querySelector(".entry img")).toBeNull();
  });

  it("is read-only after intake, with no chat input", () => {
    stubFetch({ "GET /api/speech/status": jsonResponse(speech) });
    useTripStore
      .getState()
      .applyTrip(makeTrip({ step: "review", updatedAt: "2026-02-01T00:00:00.000Z" }));
    renderUi(<ChatForStore />);
    expect(screen.queryByTestId("chat-input")).not.toBeInTheDocument();
    expect(screen.getByText(/read-only/)).toBeInTheDocument();
  });
});
