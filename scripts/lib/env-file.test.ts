import { describe, expect, it } from "vitest";
import { llmKeyFrom, envValue, mergeEnv, parseEnvText } from "./env-file.ts";

describe("env-file helpers", () => {
  it("parses comments, blanks, quotes and values containing =", () => {
    const parsed = parseEnvText('# comment\nA=1\n\nB="two words"\nC=x=y\nD=\n');
    expect(parsed).toEqual({ A: "1", B: "two words", C: "x=y", D: "" });
  });

  it("lets variables already set win over the file", () => {
    const merged = mergeEnv({ A: "file", B: "file" }, { A: "shell" });
    expect(merged.A).toBe("shell");
    expect(merged.B).toBe("file");
  });

  it("treats blank values as unset, and accepts the key alias", () => {
    expect(envValue({ A: "  " }, "A")).toBeUndefined();
    expect(llmKeyFrom({ LLM_API_KEY: "n", APEX_API_KEY: "k" })).toBe("n");
    expect(llmKeyFrom({ APEX_API_KEY: "k" })).toBe("k");
    expect(llmKeyFrom({ APEX_API_KEY: "" })).toBeUndefined();
    expect(llmKeyFrom({})).toBeUndefined();
  });
});
