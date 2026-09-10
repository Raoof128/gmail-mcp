import { GmailMcpError } from "@gmail-mcp/shared/errors";
import { MediaType, type InlineAttachment, type MessageFormat } from "@gmail-mcp/shared/schemas";
import { sha256Hex } from "../crypto/canonical";
import { fromB64url } from "../crypto/random";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { gmailJson } from "../google/gmail";
import { gmailFormatFor, type GmailMessage } from "../google/messages";
import { LIMITS, assertNotBlocked } from "../policy/limits";

export type DecodedInline = { filename: string; mime: string; size: number; sha256: string; bytes: Uint8Array };

function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  try {
    return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  } catch {
    return fromB64url(clean);
  }
}

/**
 * Spec 2.7's 1 MB is enforced before the bytes exist: each string's decoded size is projected from its
 * length, the running total is checked before the decode, and the blocked list and media type are
 * checked before that. Fifty strings just under the per-item cap cannot add up to more than 1 MiB decoded.
 */
export async function decodeInline(inline: InlineAttachment[] | undefined): Promise<DecodedInline[]> {
  const out: DecodedInline[] = [];
  let total = 0;
  for (const i of inline ?? []) {
    assertNotBlocked(i.filename);
    MediaType.parse(i.mime);
    const projected = Math.floor((i.content_base64.length * 3) / 4) - 2;
    if (total + projected > LIMITS.inlineAttachmentBytes) {
      throw new GmailMcpError(
        "limit_exceeded",
        `limit_exceeded: inline attachments exceed ${LIMITS.inlineAttachmentBytes} bytes`,
      );
    }
    const bytes = decodeBase64(i.content_base64);
    total += bytes.byteLength;
    if (total > LIMITS.inlineAttachmentBytes) {
      throw new GmailMcpError(
        "limit_exceeded",
        `limit_exceeded: inline attachments exceed ${LIMITS.inlineAttachmentBytes} bytes`,
      );
    }
    out.push({
      filename: i.filename,
      mime: i.mime,
      size: bytes.byteLength,
      sha256: await sha256Hex(new Uint8Array(bytes)),
      bytes,
    });
  }
  return out;
}

/** The client's arguments as the intent hash sees them: inline bytes replaced by their digest. */
export function intentArgs(args: Record<string, unknown>, inline: DecodedInline[]): Record<string, unknown> {
  const { inline_attachments: _dropped, ...rest } = args;
  for (const k of Object.keys(rest)) if (rest[k] === undefined) delete rest[k];
  return inline.length === 0
    ? rest
    : {
        ...rest,
        inline_attachments: inline.map((d) => ({ filename: d.filename, mime: d.mime, size: d.size, sha256: d.sha256 })),
      };
}

export async function getMessage(
  env: Env,
  deps: Deps,
  acct: { userId: string; accountId: string },
  id: string,
  format: MessageFormat,
): Promise<GmailMessage> {
  const q = gmailFormatFor(format);
  return gmailJson<GmailMessage>(env, deps, acct, {
    method: "GET",
    path: `messages/${encodeURIComponent(id)}`,
    query: { format: q.format, metadataHeaders: q.metadataHeaders },
    retry: "safe",
  });
}
