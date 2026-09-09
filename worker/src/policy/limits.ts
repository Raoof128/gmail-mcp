import { GmailMcpError } from "@gmail-mcp/shared/errors";

export const LIMITS = {
  subjectBytes: 998,
  bodyBytes: 512 * 1024,
  inlineAttachmentBytes: 1024 * 1024,
  stagedFileBytes: 25 * 1024 * 1024,
  canonicalPayloadBytes: 1024 * 1024,
  filenameBytes: 255,
} as const;

/**
 * Seeded from support.google.com/mail/answer/6590 on 2026-09-09.
 * Describes what Gmail refuses to send, so it gates uploads only, never downloads to disk.
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  "ade",
  "adp",
  "apk",
  "appx",
  "appxbundle",
  "bat",
  "cab",
  "chm",
  "cmd",
  "com",
  "cpl",
  "diagcab",
  "diagcfg",
  "diagpack",
  "dll",
  "dmg",
  "ex",
  "ex_",
  "exe",
  "hta",
  "img",
  "ins",
  "iso",
  "isp",
  "jar",
  "jnlp",
  "js",
  "jse",
  "lib",
  "lnk",
  "mde",
  "mjs",
  "msc",
  "msi",
  "msix",
  "msixbundle",
  "msp",
  "mst",
  "nsh",
  "pif",
  "ps1",
  "scr",
  "sct",
  "shb",
  "sys",
  "vb",
  "vbe",
  "vbs",
  "vhd",
  "vxd",
  "wsc",
  "wsf",
  "wsh",
  "xll",
]);

export function assertNotBlocked(filename: string): void {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return;
  const ext = filename.slice(dot + 1).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) throw new GmailMcpError("blocked_extension", `blocked_extension: .${ext}`);
}

// Matching control and bidirectional-override characters is the point of this pattern: they are
// what a hostile filename uses to hide its real extension.
// eslint-disable-next-line no-control-regex
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Cuts a string to at most `max` UTF-8 bytes on a scalar boundary. */
function truncateUtf8(s: string, max: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    // iterating a string yields whole code points, so a surrogate pair is never split
    const n = utf8Length(ch);
    if (bytes + n > max) break;
    out += ch;
    bytes += n;
  }
  return out;
}

export function sanitizeFilename(name: string): string {
  let base = name.split(/[\\/]/).pop() ?? "";
  base = base.normalize("NFC").replace(CONTROL_OR_BIDI, "_").trim();
  if (base === "" || /^\.+$/.test(base)) return "attachment";
  if (utf8Length(base) <= LIMITS.filenameBytes) return base;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 && base.length - dot <= 16 ? base.slice(dot) : "";
  const stem = dot > 0 && ext ? base.slice(0, dot) : base;
  const cut = truncateUtf8(stem, LIMITS.filenameBytes - utf8Length(ext));
  return (cut === "" ? "attachment" : cut) + ext;
}

export function assertHeaderSafe(field: string, value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new GmailMcpError("invalid_header", `invalid_header: ${field} contains control characters`);
  }
  if (field === "subject" && utf8Length(value) > LIMITS.subjectBytes) {
    throw new GmailMcpError("limit_exceeded", `limit_exceeded: subject > ${LIMITS.subjectBytes} bytes`);
  }
}
