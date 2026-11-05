import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../App";
import { installAuthGate, resetAuthGate } from "../authStore";
import { resetTripStore } from "../store";
import { jsonResponse, stubEventSource, stubFetch } from "../test/fixtures";
import { renderUi } from "../test/render";

const summary = {
  id: "t1",
  title: "Unlocked trip",
  step: "intake",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const gateFetch = () => {
  let unlocked = false;
  return stubFetch({
    "POST /api/auth": ({ body }) => {
      if ((body as { password: string }).password === "open sesame") {
        unlocked = true;
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ error: "Wrong password." }, 401);
    },
    "GET /api/trips": () =>
      unlocked
        ? jsonResponse([summary])
        : jsonResponse({ error: "This app needs a password." }, 401),
  });
};

beforeEach(() => {
  resetTripStore();
  stubEventSource();
  installAuthGate();
});
afterEach(() => resetAuthGate());

describe("auth gate", () => {
  it("does not appear without a 401", async () => {
    stubFetch({ "GET /api/trips": jsonResponse([summary]) });
    renderUi(<App />);
    expect(await screen.findByText("Unlocked trip")).toBeInTheDocument();
    expect(screen.queryByLabelText("Access password")).not.toBeInTheDocument();
  });

  it("shows a password form on 401, posts it, then retries the original request", async () => {
    const user = userEvent.setup();
    const { calls } = gateFetch();
    renderUi(<App />);
    const input = await screen.findByLabelText("Access password");
    await user.type(input, "open sesame");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("Unlocked trip")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText("Access password")).not.toBeInTheDocument());
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/trips",
      "POST /api/auth",
      "GET /api/trips",
    ]);
    expect(calls[1]?.body).toEqual({ password: "open sesame" });
  });

  it("shows a wrong password as text and stays open", async () => {
    const user = userEvent.setup();
    gateFetch();
    renderUi(<App />);
    await user.type(await screen.findByLabelText("Access password"), "wrong{Enter}");
    expect(await screen.findByText("Wrong password.")).toBeInTheDocument();
    expect(screen.getByLabelText("Access password")).toBeInTheDocument();
    expect(screen.queryByText("Unlocked trip")).not.toBeInTheDocument();
  });
});
