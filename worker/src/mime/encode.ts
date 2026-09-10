import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { assertHeaderSafe } from "../policy/limits";
import { parseAddress } from "../policy/recipients";

const enc = new TextEncoder();
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LINE_INPUT = 57; // 57 bytes -> 76 characters
const SOFT_LINE = 78;
const HARD_LINE = 998;

export function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64[a >> 2]! + B64[((a & 3) << 4) | (b >> 4)]!;
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)]! : "=";
    out += i + 2 < bytes.length ? B64[c & 63]! : "=";
  }
  return out;
}

const isPrintableAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 B encoding. Each encoded word stays within 75 characters by encoding at most 45 input bytes. */
export function encodeWord(s: string): string {
  if (isPrintableAscii(s)) return s;
  return encodeWords(s);
}

/**
 * `maxWord` is the longest encoded word the caller can place on a line. RFC 2047's own ceiling is 75,
 * but a header name eats into the first line, so `foldHeader` asks for a shorter word rather than
 * emitting a 75-character word that pushes `Subject: ` past 78.
 */
function encodeWords(s: string, maxWord = 75): string {
  const perWord = Math.floor((Math.max(maxWord, 24) - "=?UTF-8?B??=".length) / 4) * 3;
  const bytes = enc.encode(s);
  const words: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + perWord);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    words.push(`=?UTF-8?B?${base64(bytes.subarray(start, end))}?=`);
    start = end;
  }
  return words.join("\r\n ");
}

const pctEncode = (s: string) =>
  Array.from(enc.encode(s), (b) =>
    (b >= 0x30 && b <= 0x39) ||
    (b >= 0x41 && b <= 0x5a) ||
    (b >= 0x61 && b <= 0x7a) ||
    b === 0x2e ||
    b === 0x2d ||
    b === 0x5f
      ? String.fromCharCode(b)
      : `%${b.toString(16).toUpperCase().padStart(2, "0")}`,
  ).join("");

/** RFC 2231 parameter. Quoted form only for short, plain ASCII values; everything else is extended. */
export function encodeParam(name: string, value: string): string {
  assertHeaderSafe(name, value);
  if (isPrintableAscii(value) && !/["\\]/.test(value) && value.length <= 60) return `${name}="${value}"`;
  const encoded = `UTF-8''${pctEncode(value)}`;
  if (encoded.length <= 70) return `${name}*=${encoded}`;
  const pieces: string[] = [];
  let rest = encoded;
  while (rest.length > 0) {
    let n = Math.min(60, rest.length);
    const cutAt = rest.lastIndexOf("%", n - 1);
    if (cutAt > n - 3 && n < rest.length) n = cutAt;
    pieces.push(rest.slice(0, n));
    rest = rest.slice(n);
  }
  return pieces.map((p, i) => `${name}*${i}*=${p}`).join(";\r\n ");
}

export function formatMailbox(raw: string): string {
  assertHeaderSafe("address", raw);
  parseAddress(raw);
  const m = /^(.*?)\s*<([^<>]+)>$/.exec(raw.trim());
  if (!m) return `<${raw.trim()}>`;
  const name = m[1]!.trim().replace(/^"(.*)"$/, "$1");
  const addr = m[2]!.trim();
  if (name === "") return `<${addr}>`;
  if (isPrintableAscii(name)) return `"${name.replace(/(["\\])/g, "\\$1")}" <${addr}>`;
  return `${encodeWords(name)} <${addr}>`;
}

/**
 * RFC 5322 folding. Words already separated by CRLF-space (encoded words, mailbox lists) are re-flowed
 * with plain words. A token that cannot fit under the hard limit on its own is only possible for an
 * unencoded value, which is then B-encoded so it can fold. The final assertion is the law: no physical
 * line over 998 characters leaves this function.
 */
export function foldHeader(name: string, value: string): string {
  assertHeaderSafe(name, value.replace(/\r\n[ \t]/g, " "));
  const tokens = value.split(/\r\n[ \t]| /).filter((t) => t.length > 0);
  if (tokens.some((t) => t.length > HARD_LINE - name.length - 2) && isPrintableAscii(value.replace(/\r\n/g, ""))) {
    return foldHeader(name, encodeWords(value.replace(/\r\n[ \t]/g, " "), SOFT_LINE - name.length - 2));
  }
  const lines: string[] = [];
  let cur = `${name}:`;
  for (const t of tokens) {
    if (cur.length + 1 + t.length > SOFT_LINE && cur !== `${name}:`) {
      lines.push(cur);
      cur = ` ${t}`;
    } else cur += ` ${t}`;
  }
  lines.push(cur);
  for (const l of lines) {
    if (l.length > HARD_LINE)
      throw new GmailMcpError("invalid_header", `invalid_header: ${name} line exceeds ${HARD_LINE} characters`);
  }
  return lines.join("\r\n") + "\r\n";
}

const RESTRICTED = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
export function assertMediaType(mime: string): void {
  if (!RESTRICTED.test(mime))
    throw new GmailMcpError("invalid_header", `invalid_header: media type ${mime.slice(0, 40)}`);
}

export function base64LineLength(n: number): number {
  const rem = n % LINE_INPUT;
  return Math.floor(n / LINE_INPUT) * 78 + (rem === 0 ? 0 : Math.ceil(rem / 3) * 4 + 2);
}

function encodeLines(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(base64LineLength(bytes.length));
  let o = 0;
  for (let i = 0; i < bytes.length; i += LINE_INPUT) {
    const line = base64(bytes.subarray(i, Math.min(bytes.length, i + LINE_INPUT)));
    for (let j = 0; j < line.length; j++) out[o++] = line.charCodeAt(j);
    out[o++] = 13;
    out[o++] = 10;
  }
  return out;
}

export function base64Lines(bytes: Uint8Array): Uint8Array {
  return encodeLines(bytes);
}

/** Carries fewer than 57 bytes between chunks so line boundaries are identical to the whole-array encoding. */
export function base64LinesTransform(): TransformStream<Uint8Array, Uint8Array> {
  let carry = new Uint8Array(0);
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const joined = new Uint8Array(carry.length + chunk.length);
      joined.set(carry, 0);
      joined.set(chunk, carry.length);
      const usable = joined.length - (joined.length % LINE_INPUT);
      if (usable > 0) controller.enqueue(encodeLines(joined.subarray(0, usable)));
      carry = joined.slice(usable);
    },
    flush(controller) {
      if (carry.length > 0) controller.enqueue(encodeLines(carry));
    },
  });
}
