import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Slogan, SLOGAN_INTERVAL_MS, SLOGANS } from "./Slogan";

describe("Slogan", () => {
  it("has exactly the three required slogans", () => {
    expect(SLOGANS).toEqual([
      "Where do you want to travel?",
      "When do you want to travel?",
      "Quo vadis?",
    ]);
  });

  it("cycles through them in order and wraps around", () => {
    vi.useFakeTimers();
    render(<Slogan />);
    const heading = () => screen.getByRole("heading", { level: 1 });
    for (const expected of [...SLOGANS, SLOGANS[0]]) {
      expect(heading()).toHaveTextContent(expected);
      act(() => {
        vi.advanceTimersByTime(SLOGAN_INTERVAL_MS);
      });
    }
  });

  it("animates by default, and with reduced motion still cycles without animating", () => {
    vi.useFakeTimers();
    const first = render(<Slogan />);
    expect(screen.getByText(SLOGANS[0])).toHaveClass("slogan__text--animated");
    first.unmount();

    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }));
    render(<Slogan />);
    expect(screen.getByText(SLOGANS[0])).not.toHaveClass("slogan__text--animated");
    act(() => {
      vi.advanceTimersByTime(SLOGAN_INTERVAL_MS);
    });
    expect(screen.getByText(SLOGANS[1])).toBeInTheDocument();
  });

  it("stops its timer on unmount", () => {
    vi.useFakeTimers();
    const { unmount } = render(<Slogan />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
