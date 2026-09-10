import { describe, it, expect } from "vitest";
import {
  encodeWord,
  encodeParam,
  formatMailbox,
  base64Lines,
  base64LineLength,
  base64LinesTransform,
  foldHeader,
  assertMediaType,
} from "../src/mime/encode";
import { buildMime, buildMimeStream, fromBytes } from "../src/mime/build";

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const enc = new TextEncoder();

describe("encoders", () => {
  it("RFC 2047: ASCII passes through, non-ASCII becomes B words of at most 75 chars", () => {
    expect(encodeWord("Hello world")).toBe("Hello world");
    expect(encodeWord("Thesis 🚀 draft")).toBe("=?UTF-8?B?VGhlc2lzIPCfmoAgZHJhZnQ=?=");
    const long = encodeWord("é".repeat(80));
    for (const w of long.split("\r\n ")) expect(w.length).toBeLessThanOrEqual(75);
    expect(long.split("\r\n ").length).toBeGreaterThan(1);
  });
  it("RFC 2231: plain filenames stay quoted, everything else is percent-encoded with continuations", () => {
    expect(encodeParam("filename", "notes.pdf")).toBe('filename="notes.pdf"');
    expect(encodeParam("filename", 'we"ird.pdf')).toBe("filename*=UTF-8''we%22ird.pdf");
    expect(encodeParam("filename", "résumé.pdf")).toBe("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
    const long = encodeParam("filename", "a".repeat(150) + ".pdf");
    expect(long).toMatch(/^filename\*0\*=UTF-8''a+;\r\n filename\*1\*=a+/);
  });
  it("mailboxes: bare, quoted name, encoded name; CR LF NUL refused", () => {
    expect(formatMailbox("a@example.test")).toBe("<a@example.test>");
    expect(formatMailbox("Jane Doe <jane@example.test>")).toBe('"Jane Doe" <jane@example.test>');
    expect(formatMailbox("Zoë <zoe@example.test>")).toBe("=?UTF-8?B?Wm/Dqw==?= <zoe@example.test>");
    expect(() => formatMailbox("Bad\r\nName <x@example.test>")).toThrow();
  });
  it("folding: long ASCII subjects fold at spaces under 78; an unbreakable run is B-encoded; no line ever exceeds 998", () => {
    const words = foldHeader("Subject", Array.from({ length: 40 }, (_, i) => `word${i}`).join(" "));
    for (const line of words.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    expect(words.replace(/\r\n /g, " ")).toBe(
      `Subject: ${Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ")}\r\n`,
    );
    const run = foldHeader("Subject", "A".repeat(998));
    expect(run).toContain("=?UTF-8?B?");
    for (const line of run.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    const refs = foldHeader("References", Array.from({ length: 60 }, (_, i) => `<id${i}@example.test>`).join(" "));
    for (const line of refs.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    expect(refs.split("\r\n").length).toBeGreaterThan(10);
  });
  it("media types: type/subtype only", () => {
    assertMediaType("application/pdf");
    assertMediaType("image/svg+xml");
    for (const bad of [
      "pdf",
      "text/plain; charset=UTF-8",
      "text/",
      "/x",
      "a b/c",
      "text/plain\r\nX: y",
      "x".repeat(300) + "/y",
    ]) {
      expect(() => assertMediaType(bad)).toThrow(/invalid_header/);
    }
  });
  it("base64 lines are 76 wide with CRLF, decode back, and the length formula is exact for every remainder", async () => {
    for (const n of [0, 1, 2, 3, 56, 57, 58, 113, 114, 115, 1000, 4097]) {
      const data = new Uint8Array(n).map((_, i) => (i * 7) & 255);
      const whole = base64Lines(data);
      expect(whole.byteLength).toBe(base64LineLength(n));
      const out = text(whole);
      for (const line of out.split("\r\n").filter(Boolean)) expect(line.length).toBeLessThanOrEqual(76);
      expect(Uint8Array.from(atob(out.replace(/\r\n/g, "")), (c) => c.charCodeAt(0))).toEqual(data);
      // Streaming with awkward chunk boundaries yields byte-identical output.
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < n; i += 13) chunks.push(data.subarray(i, Math.min(n, i + 13)));
      const streamed = new Uint8Array(
        await new Response(new Response(new Blob(chunks)).body!.pipeThrough(base64LinesTransform())).arrayBuffer(),
      );
      expect(streamed).toEqual(whole);
    }
  });
});

describe("buildMime", () => {
  const base = {
    from: "Owner <owner@example.test>",
    to: ["a@example.test", "Zoë <zoe@example.test>"],
    cc: [],
    bcc: ["hidden@example.test"],
    subject: "Thesis 🚀",
    messageId: "<op_x@gmail-mcp.example.workers.dev>",
    date: new Date("2026-09-10T00:00:00Z"),
  };
  const att = (filename: string, mime: string, bytes: Uint8Array) => ({
    filename,
    mime,
    size: bytes.byteLength,
    open: fromBytes(bytes),
  });
  it("plain text message: headers, encoded subject, Message-ID, base64 body, exact length", async () => {
    const input = { ...base, text: "hello\n", attachments: [] };
    const bytes = await buildMime(input);
    expect(bytes.byteLength).toBe(buildMimeStream(input).length);
    const out = text(bytes);
    const [headers, body] = out.split("\r\n\r\n");
    expect(headers).toContain('From: "Owner" <owner@example.test>');
    // The mailbox list arrives folded and is re-flowed: a fold survives only where 78 characters demand one.
    expect(headers).toContain("To: <a@example.test>, =?UTF-8?B?Wm/Dqw==?= <zoe@example.test>");
    expect(headers).toContain("Bcc: <hidden@example.test>");
    expect(headers).toContain("Subject: =?UTF-8?B?VGhlc2lzIPCfmoA=?=");
    expect(headers).toContain("Message-ID: <op_x@gmail-mcp.example.workers.dev>");
    expect(headers).toContain("Date: Thu, 10 Sep 2026 00:00:00 GMT");
    expect(headers).toContain("MIME-Version: 1.0");
    expect(headers).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(atob(body!.trim())).toBe("hello\n");
    expect(out).not.toContain("\n\n");
  });
  it("text plus html plus attachment: mixed wrapping alternative, RFC 2231 filename, In-Reply-To, exact length", async () => {
    const input = {
      ...base,
      text: "t",
      html: "<b>t</b>",
      inReplyTo: "<parent@fake.test>",
      references: "<root@fake.test> <parent@fake.test>",
      attachments: [att("résumé.pdf", "application/pdf", enc.encode("%PDF-1.4"))],
    };
    const bytes = await buildMime(input);
    expect(bytes.byteLength).toBe(buildMimeStream(input).length);
    const out = text(bytes);
    expect(out).toMatch(/Content-Type: multipart\/mixed; boundary="[^"]+"/);
    expect(out).toMatch(/Content-Type: multipart\/alternative; boundary="[^"]+"/);
    expect(out).toContain("Content-Type: text/html; charset=UTF-8");
    expect(out).toContain("Content-Type: application/pdf; name*=UTF-8''r%C3%A9sum%C3%A9.pdf");
    expect(out).toContain("Content-Disposition: attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
    expect(out).toContain("In-Reply-To: <parent@fake.test>");
    expect(out).toContain("References: <root@fake.test> <parent@fake.test>");
    expect(out).toContain(btoa("%PDF-1.4"));
  });
  it("refuses header injection and bad media types anywhere", () => {
    expect(() => buildMimeStream({ ...base, subject: "x\r\nBcc: evil@x.test", text: "t", attachments: [] })).toThrow(
      /invalid_header/,
    );
    expect(() =>
      buildMimeStream({ ...base, text: "t", attachments: [att("a\nb.pdf", "application/pdf", new Uint8Array(1))] }),
    ).toThrow(/invalid_header/);
    expect(() =>
      buildMimeStream({ ...base, text: "t", attachments: [att("a.pdf", "application/pdf; x=y", new Uint8Array(1))] }),
    ).toThrow(/invalid_header/);
  });
  it("streams a 6 MB attachment with bounded chunks and errors when the source is shorter than declared", async () => {
    const big = new Uint8Array(6 * 1024 * 1024).fill(65);
    const { stream, length } = buildMimeStream({
      ...base,
      text: "t",
      attachments: [att("big.bin", "application/octet-stream", big)],
    });
    let total = 0;
    let largest = 0;
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      largest = Math.max(largest, value.byteLength);
    }
    expect(total).toBe(length);
    expect(largest).toBeLessThan(1024 * 1024);
    const lying = {
      ...base,
      text: "t",
      attachments: [
        { filename: "short.bin", mime: "application/octet-stream", size: 100, open: fromBytes(new Uint8Array(50)) },
      ],
    };
    await expect(new Response(buildMimeStream(lying).stream).arrayBuffer()).rejects.toThrow(/handle_invalid/);
  });
});
