import { z } from "zod";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { SessionStatus, UploadEndpoint } from "../operations/recovery-types";

const refused = () => new GmailMcpError("gmail_error", "invalid resumable session endpoint");
/** Inspect raw grammar before URL can erase traversal. Never include capability text in errors. */
export function validateSessionUrl(raw: string, endpoint: UploadEndpoint): URL {
  if (raw.length > 4096 || /[^\x21-\x7e]/.test(raw) || /[\\#]/.test(raw)) throw refused();
  const match = /^https:\/\/(gmail\.googleapis\.com|www\.googleapis\.com)(?::443)?(\/[^?]*)\?([^?]+)$/.exec(raw);
  if (!match) throw refused();
  const path = match[2]!;
  if (path.includes("%") || path.split("/").some((p) => p === "." || p === "..")) throw refused();
  let suffix: string;
  if (endpoint.kind === "send") suffix = "messages/send";
  else if (endpoint.kind === "draft_create") suffix = "drafts";
  else {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(endpoint.draftId)) throw refused();
    suffix = `drafts/${endpoint.draftId}`;
  }
  if (
    !["/upload/gmail/v1/users/me/", "/resumable/upload/gmail/v1/users/me/"].some((prefix) => path === prefix + suffix)
  )
    throw refused();
  const parts = match[3]!.split("&").sort();
  if (parts.length !== 2 || parts[0] !== "uploadType=resumable" || !/^upload_id=[A-Za-z0-9_-]{1,1024}$/.test(parts[1]!))
    throw refused();
  const url = new URL(raw);
  if (url.pathname !== path || url.hostname !== match[1] || url.username || url.password || url.hash) throw refused();
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
