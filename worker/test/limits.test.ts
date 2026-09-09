import { describe, it, expect } from "vitest";
import {
  BLOCKED_EXTENSIONS,
  assertNotBlocked,
  sanitizeFilename,
  assertHeaderSafe,
  LIMITS,
  utf8Length,
} from "../src/policy/limits";

describe("blocked extensions", () => {
  it("contains Google's published set", () => {
    for (const e of [
      "exe",
      "dll",
      "bat",
      "cmd",
      "js",
      "jse",
      "vbs",
      "msi",
      "jar",
      "apk",
      "appx",
      "iso",
      "ps1",
      "mjs",
      "msix",
      "lnk",
      "vhd",
      "xll",
    ]) {
      expect(BLOCKED_EXTENSIONS.has(e), e).toBe(true);
    }
  });
  it("rejects by final extension, case-insensitively, and not by name prefix", () => {
    expect(() => assertNotBlocked("setup.EXE")).toThrow(/blocked_extension/);
    expect(() => assertNotBlocked("report.pdf")).not.toThrow();
    expect(() => assertNotBlocked("archive.tar.gz")).not.toThrow();
    expect(() => assertNotBlocked("exe")).not.toThrow();
  });
});

describe("sanitizeFilename", () => {
  it("keeps basename only and strips path characters", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\x\\a.pdf")).toBe("a.pdf");
  });
  it("replaces control and bidi characters and NFC-normalises", () => {
    expect(sanitizeFilename("in\u202evoice.pdf")).toBe("in_voice.pdf");
    expect(sanitizeFilename("a\u0000b.txt")).toBe("a_b.txt");
    expect(sanitizeFilename("e\u0301.txt")).toBe("\u00e9.txt");
  });
  it("never returns empty or dot-only names", () => {
    expect(sanitizeFilename("..")).toBe("attachment");
    expect(sanitizeFilename("")).toBe("attachment");
  });
  it("truncates by UTF-8 bytes without splitting a scalar and keeps the extension", () => {
    const emoji = "\u{1F600}";
    const long = emoji.repeat(100) + ".pdf";
    const out = sanitizeFilename(long);
    expect(utf8Length(out)).toBeLessThanOrEqual(255);
    expect(out.endsWith(".pdf")).toBe(true);
    expect(out.isWellFormed()).toBe(true);
    expect(utf8Length(out)).toBe(4 * 62 + 4);
  });
});

describe("headers and sizes", () => {
  it("rejects CR, LF, NUL in header values with invalid_header", () => {
    expect(() => assertHeaderSafe("subject", "hi\r\nBcc: x")).toThrow(/invalid_header/);
    expect(() => assertHeaderSafe("subject", "ok")).not.toThrow();
  });
  it("enforces subject byte cap", () => {
    expect(() => assertHeaderSafe("subject", "x".repeat(LIMITS.subjectBytes + 1))).toThrow(/limit_exceeded/);
    expect(utf8Length("\u00e9")).toBe(2);
  });
});
