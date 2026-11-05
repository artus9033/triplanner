import { useMediaQuery } from "@mui/material";
import { useEffect, useState } from "react";

export const SLOGANS = [
  "Where do you want to travel?",
  "When do you want to travel?",
  "Quo vadis?",
] as const;
export const SLOGAN_INTERVAL_MS = 4_000;

/** Cycles for everyone. With reduced motion the words simply change, with no drift or fade. */
export function Slogan() {
  const [index, setIndex] = useState(0);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)", { noSsr: true });

  useEffect(() => {
    const timer = setInterval(
      () => setIndex((current) => (current + 1) % SLOGANS.length),
      SLOGAN_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="hero">
      <h1 className="slogan" data-testid="slogan">
        <span
          key={index}
          className={reducedMotion ? "slogan__text" : "slogan__text slogan__text--animated"}
          style={{ "--slogan-ms": `${SLOGAN_INTERVAL_MS}ms` } as React.CSSProperties}
        >
          {SLOGANS[index]}
        </span>
      </h1>
      <svg className="hero__route" viewBox="0 0 420 24" fill="none" aria-hidden="true">
        <path
          d="M3 18 C 70 2, 120 24, 190 12 S 330 2, 405 14"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="2 6"
          strokeLinecap="round"
        />
        <circle cx="3" cy="18" r="3" fill="currentColor" />
        <path d="M405 6l5 8-5 8-5-8z" fill="currentColor" />
      </svg>
    </div>
  );
}
