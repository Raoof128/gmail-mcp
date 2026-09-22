import { z } from "zod";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { SessionStatus, UploadEndpoint } from "../operations/recovery-types";

const KNOWN_SEGMENTS = new Set(["upload", "resumable", "gmail", "v1", "users", "me", "drafts", "messages", "send"]);
const KNOWN_VALUES = new Set(["resumable", "multipart", "media"]);
/** Length plus the sorted set of non-alphanumeric characters: enough to diagnose, never the value itself. */
const opaque = (tag: string, v: string) =>
  `<${tag}:${v.length}:${[...new Set(v.replace(/[A-Za-z0-9]/g, ""))].sort().join("")}>`;
export type SessionUrlShape = {
  length: number;
  scheme: string;
  host: string;
  path: string[];
  query: { name: string; value: string }[];
  fragment: boolean;
  backslash: boolean;
  nonPrintable: boolean;
};
/**
 * A refused session URL, reduced to what a diagnosis needs. The upload id is a bearer capability and a
 * path segment may carry the mailbox address, so every value outside a fixed vocabulary is replaced by
 * its length and punctuation. Parameter names are Google's, not the owner's, and are kept verbatim.
 */
export function describeSessionUrl(raw: string): SessionUrlShape {
  const m = /^([^:/?#]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/.exec(raw);
  const host = m?.[2] ?? "";
  return {
    length: raw.length,
    scheme: m?.[1] === "https" || m?.[1] === "http" ? m[1] : opaque("scheme", m?.[1] ?? ""),
    host: /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/.test(host) ? host : opaque("host", host),
    path: (m?.[3] ?? "")
      .split("/")
      .filter((seg) => seg !== "")
      .map((seg) => (KNOWN_SEGMENTS.has(seg) ? seg : opaque("seg", seg))),
    query: (m?.[4] ?? "")
      .split("&")
      .filter((p) => p !== "")
      .map((p) => {
        const i = p.indexOf("=");
        const name = i < 0 ? p : p.slice(0, i);
        const value = i < 0 ? "" : p.slice(i + 1);
        return {
          name: /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? name : opaque("name", name),
          value: KNOWN_VALUES.has(value) ? value : opaque("len", value),
        };
      }),
    fragment: raw.includes("#"),
    backslash: raw.includes("\\"),
    nonPrintable: /[^\x21-\x7e]/.test(raw),
  };
}
const refused = (reason: string, raw: string) => {
  console.warn(JSON.stringify({ event: "resumable_session_refused", reason, shape: describeSessionUrl(raw) }));
  return new GmailMcpError("gmail_error", "invalid resumable session endpoint");
};
/** Inspect raw grammar before URL can erase traversal. Never include capability text in errors. */
export function validateSessionUrl(raw: string, endpoint: UploadEndpoint): URL {
  if (raw.length > 4096 || /[^\x21-\x7e]/.test(raw) || /[\\#]/.test(raw)) throw refused("grammar", raw);
  const match = /^https:\/\/(gmail\.googleapis\.com|www\.googleapis\.com)(?::443)?(\/[^?]*)\?([^?]+)$/.exec(raw);
  if (!match) throw refused("origin", raw);
  const path = match[2]!;
  if (path.includes("%") || path.split("/").some((p) => p === "." || p === "..")) throw refused("traversal", raw);
  let suffix: string;
  if (endpoint.kind === "send") suffix = "messages/send";
  else if (endpoint.kind === "draft_create") suffix = "drafts";
  else {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(endpoint.draftId)) throw refused("draft_id", raw);
    suffix = `drafts/${endpoint.draftId}`;
  }
  if (
    !["/upload/gmail/v1/users/me/", "/resumable/upload/gmail/v1/users/me/"].some((prefix) => path === prefix + suffix)
  )
    throw refused("path", raw);
  // Exactly uploadType and upload_id, plus the session_crd Google's live session URLs carry (seen
  // 2026-09-23: 512 base64url characters). Each at most once; any other parameter is refused.
  const parts = match[3]!.split("&");
  const crd = parts.filter((p) => p.startsWith("session_crd="));
  const rest = parts.filter((p) => !p.startsWith("session_crd=")).sort();
  if (
    crd.length > 1 ||
    (crd.length === 1 && !/^session_crd=[A-Za-z0-9_-]{1,2048}$/.test(crd[0]!)) ||
    rest.length !== 2 ||
    rest[0] !== "uploadType=resumable" ||
    !/^upload_id=[A-Za-z0-9_-]{1,1024}$/.test(rest[1]!)
  )
    throw refused("query", raw);
  const url = new URL(raw);
  if (url.pathname !== path || url.hostname !== match[1] || url.username || url.password || url.hash)
    throw refused("url", raw);
  return url;
}
const wireId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const wireMessage = z.object({ id: wireId, threadId: wireId, labelIds: z.array(wireId).max(1000).optional() });
export function parseSessionStatus(
  status: number,
  range: string | null,
  total: number,
  previousOffset: number,
  body: Uint8Array,
  resultVersion: "send-v1",
): SessionStatus {
  const invalid: SessionStatus = { kind: "unknown", reason: "invalid_response" };
  if (
    resultVersion !== "send-v1" ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    total > 36700160 ||
    !Number.isSafeInteger(previousOffset) ||
    previousOffset < 0 ||
    previousOffset > total ||
    body.length > 65536
  )
    return invalid;
  if (status === 404 || status === 410) return { kind: "unknown", reason: "expired" };
  if (status === 200 || status === 201) {
    try {
      const m = wireMessage.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body)));
      return {
        kind: "complete",
        result: { gmail_result_id: m.id, message: { id: m.id, thread_id: m.threadId, label_ids: m.labelIds ?? [] } },
      };
    } catch {
      return invalid;
    }
  }
  if (status !== 308) return invalid;
  if (range === null) return previousOffset === 0 ? { kind: "incomplete", nextOffset: 0 } : invalid;
  const m = /^(?:bytes=)?0-(\d+)$/.exec(range.trim());
  if (!m) return invalid;
  const next = Number(m[1]) + 1;
  if (!Number.isSafeInteger(next) || next < previousOffset || next > total) return invalid;
  return next === total ? { kind: "awaiting_final" } : { kind: "incomplete", nextOffset: next };
}
