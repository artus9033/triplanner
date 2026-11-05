import { describe, expect, it } from "vitest";
import { resolveToolsDir } from "./paths.ts";

describe("resolveToolsDir", () => {
  it("prefers TOOLS_DIR over everything", () => {
    expect(resolveToolsDir({ TOOLS_DIR: "/custom" }, () => true, "/home/u")).toBe("/custom");
  });
  it("uses /workspace/.tools when /workspace is writable", () => {
    expect(resolveToolsDir({}, (dir) => dir === "/workspace", "/home/u")).toBe("/workspace/.tools");
  });
  it("falls back to the home directory, and ignores a blank override", () => {
    expect(resolveToolsDir({ TOOLS_DIR: "  " }, () => false, "/home/u")).toBe("/home/u/.tools");
  });
});
