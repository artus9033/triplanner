import { describe, expect, it } from "vitest";
import { safeHttpUrl } from "./safeUrl";

describe("safeHttpUrl", () => {
  it.each([
    ["https://example.com/a?b=1", "https://example.com/a?b=1"],
    ["http://example.com", "http://example.com/"],
    ["  https://example.com/x  ", "https://example.com/x"],
    ["HTTPS://EXAMPLE.com/", "https://example.com/"],
  ])("accepts %s", (input, expected) => {
    expect(safeHttpUrl(input)).toBe(expected);
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "java\nscript:alert(1)",
    "java\tscript:alert(1)",
    "\u0001javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://example.com/",
    "tel:+331",
    "mailto:a@b.c",
    "/relative/path",
    "//example.com/protocol-relative",
    "example.com",
    "https://user:pass@example.com/",
    "",
  ])("rejects %j", (input) => {
    expect(safeHttpUrl(input)).toBeNull();
  });

  it.each([null, undefined, 42, {}, ["https://a.b"]])("rejects the non-string %j", (input) => {
    expect(safeHttpUrl(input)).toBeNull();
  });
});
