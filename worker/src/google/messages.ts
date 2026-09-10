import type { MessageFormat } from "@gmail-mcp/shared/schemas";
import { fromB64url } from "../crypto/random";

export type GmailHeader = { name: string; value: string };
export type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};
export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPart | undefined;
  raw?: string;
};
export type GmailThread = { id: string; historyId?: string; messages?: GmailMessage[] };
export type GmailDraft = { id: string; message: GmailMessage };
export type GmailLabel = {
  id: string;
  name: string;
  type?: "system" | "user";
  labelListVisibility?: string;
  messageListVisibility?: string;
  color?: { textColor: string; backgroundColor: string };
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
};

export type AttachmentMeta = {
  part_id: string;
  attachment_id: string | null;
  filename: string;
  mime: string;
  size: number;
};
export type MessageView = {
  id: string;
  thread_id: string;
  label_ids: string[];
  snippet: string;
  date: string | null;
  subject: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to: string[];
  message_id_header: string | null;
  in_reply_to: string | null;
  references: string | null;
  plaintext_body?: string;
  html_body?: string;
  raw?: string;
  body_truncated?: boolean;
  attachments: AttachmentMeta[];
};

export const METADATA_HEADERS = [
  "Subject",
  "From",
  "To",
  "Cc",
  "Bcc",
  "Reply-To",
  "Date",
  "Message-ID",
  "In-Reply-To",
  "References",
] as const;

export function gmailFormatFor(f: MessageFormat): {
  format: "minimal" | "metadata" | "full" | "raw";
  metadataHeaders?: string[];
} {
  switch (f) {
    case "MINIMAL":
      return { format: "minimal" };
    case "METADATA_ONLY":
      return { format: "metadata", metadataHeaders: [...METADATA_HEADERS] };
    case "RAW":
      return { format: "raw" };
    default:
      return { format: "full" };
  }
}

const header = (p: GmailPart | undefined, name: string): string | null => {
  const n = name.toLowerCase();
  return p?.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? null;
};

/**
 * RFC 5322 address-list splitting. A comma separates addresses only outside quoted strings (where
 * backslash escapes the next character), outside comments (which nest), and outside angle brackets.
 * A group `Name: a, b;` contributes its members and drops its name. Validation belongs to parseAddress.
 */
export function splitAddressList(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let escaped = false;
  let comment = 0;
  let angle = 0;
  let inGroup = false;
  const push = () => {
    const t = cur.trim();
    if (t) out.push(t);
    cur = "";
  };
  for (const ch of value) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (quoted) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      cur += ch;
      continue;
    }
    if (comment > 0) {
      if (ch === "(") comment++;
      else if (ch === ")") comment--;
      cur += ch;
      continue;
    }
    switch (ch) {
      case '"':
        quoted = true;
        cur += ch;
        break;
      case "(":
        comment = 1;
        cur += ch;
        break;
      case "<":
        angle++;
        cur += ch;
        break;
      case ">":
        angle = Math.max(0, angle - 1);
        cur += ch;
        break;
      case ":":
        if (angle === 0 && !inGroup) {
          inGroup = true;
          cur = "";
        } else cur += ch;
        break;
      case ";":
        if (angle === 0 && inGroup) {
          push();
          inGroup = false;
        } else cur += ch;
        break;
      case ",":
        if (angle === 0) push();
        else cur += ch;
        break;
      default:
        cur += ch;
    }
  }
  push();
  return out;
}

export function decodeBodyData(data: string): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(fromB64url(data));
}

const addresses = (p: GmailPart | undefined, name: string): string[] => {
  const v = header(p, name);
  return v ? splitAddressList(v) : [];
};

function walk(p: GmailPart | undefined, visit: (part: GmailPart) => void): void {
  if (!p) return;
  visit(p);
  for (const c of p.parts ?? []) walk(c, visit);
}

function attachmentsOf(p: GmailPart | undefined): AttachmentMeta[] {
  const out: AttachmentMeta[] = [];
  walk(p, (part) => {
    if (!part.filename) return;
    // A named part is an attachment whether Gmail parked its bytes behind attachmentId or inlined them in data.
    if (part.body?.attachmentId || part.body?.data) {
      out.push({
        part_id: part.partId ?? "",
        attachment_id: part.body.attachmentId ?? null,
        filename: part.filename,
        mime: part.mimeType ?? "application/octet-stream",
        size: part.body.size ?? 0,
      });
    }
  });
  return out;
}

function bodyOfType(p: GmailPart | undefined, type: "text/plain" | "text/html"): string | undefined {
  const chunks: string[] = [];
  walk(p, (part) => {
    if ((part.mimeType ?? "").toLowerCase() === type && !part.filename && part.body?.data)
      chunks.push(decodeBodyData(part.body.data));
  });
  return chunks.length === 0 ? undefined : chunks.join("\n");
}

/** Cuts on code points, never inside a surrogate pair, so a truncated body is still well-formed. */
function cut(s: string, max: number): { text: string; truncated: boolean } {
  let n = 0;
  let out = "";
  for (const ch of s) {
    if (n === max) return { text: out, truncated: true };
    out += ch;
    n++;
  }
  return { text: out, truncated: false };
}

export function messageView(
  m: GmailMessage,
  o: { format: MessageFormat; bodyCharLimit: number; includeBody: boolean },
): MessageView {
  const p = m.payload;
  const view: MessageView = {
    id: m.id,
    thread_id: m.threadId,
    label_ids: m.labelIds ?? [],
    snippet: m.snippet ?? "",
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
    subject: header(p, "Subject"),
    from: header(p, "From"),
    to: addresses(p, "To"),
    cc: addresses(p, "Cc"),
    bcc: addresses(p, "Bcc"),
    reply_to: addresses(p, "Reply-To"),
    message_id_header: header(p, "Message-ID"),
    in_reply_to: header(p, "In-Reply-To"),
    references: header(p, "References"),
    attachments: attachmentsOf(p),
  };
  if (!o.includeBody || o.format === "MINIMAL" || o.format === "METADATA_ONLY") return view;
  if (o.format === "RAW") {
    if (m.raw !== undefined) {
      const c = cut(m.raw, o.bodyCharLimit);
      view.raw = c.text;
      if (c.truncated) view.body_truncated = true;
    }
    return view;
  }
  const text = bodyOfType(p, "text/plain");
  if (text !== undefined) {
    const c = cut(text, o.bodyCharLimit);
    view.plaintext_body = c.text;
    if (c.truncated) view.body_truncated = true;
  }
  if (o.format === "FULL_CONTENT") {
    const html = bodyOfType(p, "text/html");
    if (html !== undefined) {
      const c = cut(html, o.bodyCharLimit);
      view.html_body = c.text;
      if (c.truncated) view.body_truncated = true;
    }
  }
  return view;
}

export function findAttachment(
  m: GmailMessage,
  by: { attachmentId: string } | { partId: string },
): AttachmentMeta | null {
  return (
    attachmentsOf(m.payload).find((a) =>
      "attachmentId" in by ? a.attachment_id === by.attachmentId : a.part_id === by.partId,
    ) ?? null
  );
}

export function partData(m: GmailMessage, partId: string): string | null {
  let found: string | null = null;
  walk(m.payload, (part) => {
    if (part.partId === partId && part.body?.data && !part.body.attachmentId) found = part.body.data;
  });
  return found;
}
