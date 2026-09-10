import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { assertHeaderSafe } from "../policy/limits";
import { b64url } from "../crypto/random";
import {
  assertMediaType,
  base64LineLength,
  base64Lines,
  base64LinesTransform,
  encodeParam,
  encodeWord,
  foldHeader,
  formatMailbox,
} from "./encode";

export type MimeAttachment = {
  filename: string;
  mime: string;
  size: number;
  open: () => Promise<ReadableStream<Uint8Array>>;
};
export type MimeInput = {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  messageId: string;
  inReplyTo?: string | undefined;
  references?: string | undefined;
  date?: Date | undefined;
  text?: string | undefined;
  html?: string | undefined;
  attachments: MimeAttachment[];
};

type Segment = { kind: "bytes"; bytes: Uint8Array } | { kind: "attachment"; att: MimeAttachment };
const enc = new TextEncoder();
const bytes = (s: string): Segment => ({ kind: "bytes", bytes: enc.encode(s) });

function boundary(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return `=_gm_${b64url(b)}`;
}

const addressHeader = (name: string, list: string[]): string =>
  list.length === 0 ? "" : foldHeader(name, list.map(formatMailbox).join(",\r\n "));

function textPart(type: "text/plain" | "text/html", body: string): Segment[] {
  return [
    bytes(`Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`),
    { kind: "bytes", bytes: base64Lines(enc.encode(body)) },
  ];
}

function attachmentPart(a: MimeAttachment): Segment[] {
  assertHeaderSafe("filename", a.filename);
  assertMediaType(a.mime);
  return [
    bytes(
      `Content-Type: ${a.mime}; ${encodeParam("name", a.filename)}\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; ${encodeParam("filename", a.filename)}\r\n\r\n`,
    ),
    { kind: "attachment", att: a },
  ];
}

function multipart(subtype: "mixed" | "alternative", parts: Segment[][]): { header: string; body: Segment[] } {
  const b = boundary();
  const body: Segment[] = [];
  for (const p of parts) body.push(bytes(`--${b}\r\n`), ...p, bytes("\r\n"));
  body.push(bytes(`--${b}--\r\n`));
  return { header: `Content-Type: multipart/${subtype}; boundary="${b}"\r\n`, body };
}

function segments(o: MimeInput): Segment[] {
  assertHeaderSafe("subject", o.subject);
  const head =
    foldHeader("From", formatMailbox(o.from)) +
    addressHeader("To", o.to) +
    addressHeader("Cc", o.cc) +
    addressHeader("Bcc", o.bcc) +
    foldHeader("Subject", encodeWord(o.subject)) +
    foldHeader("Date", (o.date ?? new Date()).toUTCString()) +
    foldHeader("Message-ID", o.messageId) +
    (o.inReplyTo ? foldHeader("In-Reply-To", o.inReplyTo) : "") +
    (o.references ? foldHeader("References", o.references) : "") +
    "MIME-Version: 1.0\r\n";
  const bodies: Segment[][] = [];
  if (o.text !== undefined) bodies.push(textPart("text/plain", o.text));
  if (o.html !== undefined) bodies.push(textPart("text/html", o.html));
  if (bodies.length === 0) bodies.push(textPart("text/plain", ""));
  let content: { header: string; body: Segment[] };
  if (bodies.length === 2) content = multipart("alternative", bodies);
  else {
    const [only] = bodies;
    const raw = new TextDecoder().decode((only![0] as { bytes: Uint8Array }).bytes);
    content = { header: raw.slice(0, -2), body: [only![1]!] };
  }
  if (o.attachments.length > 0)
    content = multipart("mixed", [
      [bytes(content.header + "\r\n"), ...content.body],
      ...o.attachments.map(attachmentPart),
    ]);
  return [bytes(head + content.header + "\r\n"), ...content.body];
}

const segmentLength = (s: Segment) => (s.kind === "bytes" ? s.bytes.byteLength : base64LineLength(s.att.size));

/**
 * Pull-based: one segment at a time, and inside an attachment one source chunk at a time through the
 * base64 transform. The length is exact before any byte is read, which both upload protocols need, and a
 * source that yields a different byte count than its declared size errors the stream rather than
 * producing a message whose Content-Length lies.
 */
export function buildMimeStream(o: MimeInput): { stream: ReadableStream<Uint8Array>; length: number } {
  const segs = segments(o);
  const length = segs.reduce((n, s) => n + segmentLength(s), 0);
  let i = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let expected = 0;
  let seen = 0;
  let current: MimeAttachment | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (reader) {
          const { done, value } = await reader.read();
          if (!done) {
            seen += value.byteLength;
            controller.enqueue(value);
            return;
          }
          if (seen !== expected) {
            controller.error(
              new GmailMcpError(
                "handle_invalid",
                `handle_invalid: ${current?.filename ?? "attachment"} yielded ${seen} encoded bytes, expected ${expected}`,
              ),
            );
            return;
          }
          reader = null;
          i++;
          continue;
        }
        if (i >= segs.length) {
          controller.close();
          return;
        }
        const seg = segs[i]!;
        if (seg.kind === "bytes") {
          controller.enqueue(seg.bytes);
          i++;
          return;
        }
        current = seg.att;
        expected = base64LineLength(seg.att.size);
        seen = 0;
        reader = (await seg.att.open()).pipeThrough(base64LinesTransform()).getReader();
      }
    },
    cancel() {
      void reader?.cancel();
    },
  });
  return { stream, length };
}

export async function buildMime(o: MimeInput): Promise<Uint8Array> {
  const { stream, length } = buildMimeStream(o);
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.byteLength !== length) throw new GmailMcpError("internal", `mime length ${out.byteLength} != ${length}`);
  return out;
}

export function fromBytes(bytes: Uint8Array): () => Promise<ReadableStream<Uint8Array>> {
  return () => Promise.resolve(new Response(bytes).body!);
}
