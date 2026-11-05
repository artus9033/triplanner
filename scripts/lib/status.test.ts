import { describe, expect, it } from "vitest";
import { compareNode } from "./status.ts";
import { backoffMs, linePrefixer, parsePort } from "./supervise.ts";

describe("compareNode", () => {
  it("classifies versions against the pin", () => {
    expect(compareNode("v24.9.0", "24.9.0")).toBe("match");
    expect(compareNode("v24.10.0", "24.9.0")).toBe("newer");
    expect(compareNode("v24.8.5", "24.9.0")).toBe("older-minor");
    expect(compareNode("v22.9.0", "24.9.0")).toBe("wrong-major");
  });
});

describe("supervision helpers", () => {
  it("backs off exponentially up to a cap", () => {
    expect([1, 2, 3, 10].map(backoffMs)).toEqual([1_000, 2_000, 4_000, 15_000]);
  });

  it("prefixes whole lines and holds partial ones", () => {
    const out: string[] = [];
    const prefixer = linePrefixer("[x] ", (text) => out.push(text));
    prefixer.push("one\ntw");
    expect(out).toEqual(["[x] one\n"]);
    prefixer.push("o\n");
    prefixer.push("three");
    expect(out).toEqual(["[x] one\n", "[x] two\n"]);
    prefixer.flush();
    expect(out.at(-1)).toBe("[x] three\n");
  });

  it("parses ports", () => {
    expect(parsePort(undefined, 3000, "PORT")).toBe(3000);
    expect(parsePort(" 4000 ", 3000, "PORT")).toBe(4000);
    expect(() => parsePort("nope", 3000, "PORT")).toThrow(/PORT is not a valid port/);
    expect(() => parsePort("70000", 3000, "PORT")).toThrow(/valid port/);
  });
});
