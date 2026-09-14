import { z } from "zod";
import type { Env } from "../env";
import type { Deps } from "../deps";
import type { Binding, Candidate, Deadlines, Lease, Observation, Proof } from "./recovery-types";
import { recoveryRequest, retryAtFor } from "../google/recovery-http";
import { parseSessionStatus, wireMessage } from "../google/resumable";
import { recoveryFences, recoveryRow } from "./recovery-admission";
import { assertion, sendResult, settlePositive } from "./recovery-state";
import { Keyring } from "../crypto/keyring";
const messageId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const candidateSchema = z.object({
  id: messageId,
  threadId: messageId,
  labels: z.array(messageId).max(1000),
  messageIds: z.array(z.string().max(512)).max(2),
  internalDate: z.number().int().nonnegative(),
});
export function verifiesCandidate(b: Binding, input: Candidate): boolean {
  const parsed = candidateSchema.safeParse(input);
  if (!parsed.success) return false;
  const c = parsed.data;
  return (
    b.executor !== "send_draft" &&
    b.generatedMessageId === `<${b.operationId}@${new URL(b.origin).hostname}>` &&
    c.messageIds.length === 1 &&
    c.messageIds[0] === b.generatedMessageId &&
    c.labels.includes("SENT") &&
    (b.threadId === null || c.threadId === b.threadId) &&
    c.internalDate >= b.startedAt - 120000 &&
    c.internalDate <= b.startedAt + 86400000
  );
}
const listSchema = z.object({
  messages: z
    .array(z.object({ id: messageId }))
    .max(2)
    .optional(),
  nextPageToken: z.string().optional(),
});
const metadataSchema = wireMessage.extend({
  internalDate: z.string().regex(/^\d+$/),
  payload: z.object({ headers: z.array(z.object({ name: z.string().max(128), value: z.string().max(512) })).max(100) }),
});
const decode = (bytes: Uint8Array): unknown =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
export async function observeDelivery(
  env: Env,
  deps: Deps,
  b: Binding,
  lease: Lease,
  deadlines: Deadlines,
): Promise<Observation> {
  const row = await recoveryRow(env.DB, b.operationId);
  if (b.executor === "send_draft") return { kind: "suspended", reason: "manual_draft" };
  if (!row || Date.now() >= row.deadline) return { kind: "suspended", reason: "expired" };
  const defer = (
    reason: "not_found" | "ambiguous" | "transport" | "awaiting_final",
    retryAt = retryAtFor(null, Date.now(), row.attempts),
  ): Observation =>
    retryAt >= row.deadline ? { kind: "suspended", reason: "expired" } : { kind: "deferred", reason, retryAt };
  try {
    if (lease.mode === "send_session_status") {
      if (!row.session_enc || !row.session_key_id || !row.session_digest || row.mime_length === null)
        return { kind: "suspended", reason: "invalid_evidence" };
      const url = await Keyring.fromEnv(env).decrypt(new Uint8Array(row.session_enc), row.session_key_id, {
        userId: b.userId,
        accountId: b.accountId,
        field: `send_session:${b.operationId}`,
      });
      const res = await recoveryRequest(env, deps, b, lease, deadlines, {
        kind: "gmail",
        url,
        init: { method: "PUT", headers: { "content-length": "0", "content-range": `bytes */${row.mime_length}` } },
      });
      if (res.kind !== "response") return res;
      if (res.status === 429 || res.status >= 500)
        return defer("transport", retryAtFor(res.retryAfter, Date.now(), row.attempts));
      const status = parseSessionStatus(
        res.status,
        res.range,
        row.mime_length,
        row.confirmed_offset,
        res.bytes,
        "send-v1",
      );
      if (status.kind === "complete")
        return {
          kind: "confirmed",
          proof: {
            kind: "session_receipt",
            operationId: b.operationId,
            sessionDigest: row.session_digest,
            result: status.result,
          },
        };
      if (status.kind === "unknown" && status.reason === "expired") {
        await env.DB.batch([
          ...recoveryFences(env, b, lease, Date.now()),
          env.DB.prepare(
            "UPDATE operation_recovery SET session_enc=NULL,session_key_id=NULL WHERE operation_id=?",
          ).bind(b.operationId),
        ]);
      } else if (status.kind === "incomplete") {
        await env.DB.batch([
          ...recoveryFences(env, b, lease, Date.now()),
          env.DB.prepare(
            "UPDATE operation_recovery SET confirmed_offset=MAX(confirmed_offset,?) WHERE operation_id=?",
          ).bind(status.nextOffset, b.operationId),
        ]);
      }
      return defer(status.kind === "awaiting_final" ? "awaiting_final" : "transport");
    }
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("q", `rfc822msgid:${b.generatedMessageId}`);
    url.searchParams.set("labelIds", "SENT");
    url.searchParams.set("maxResults", "2");
    const response = await recoveryRequest(env, deps, b, lease, deadlines, {
      kind: "gmail",
      url: url.toString(),
      init: { method: "GET" },
    });
    if (response.kind !== "response") return response;
    if (response.status !== 200) return defer("transport", retryAtFor(response.retryAfter, Date.now(), row.attempts));
    const list = listSchema.parse(decode(response.bytes));
    if (list.nextPageToken || (list.messages?.length ?? 0) > 1) return defer("ambiguous");
    if (!list.messages?.length) return defer("not_found");
    const candidateId = list.messages[0]!.id;
    const metadata = await recoveryRequest(env, deps, b, lease, deadlines, {
      kind: "gmail",
      url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${candidateId}?format=metadata&metadataHeaders=Message-ID`,
      init: { method: "GET" },
    });
    if (metadata.kind !== "response") return metadata;
    if (metadata.status !== 200) return defer("transport", retryAtFor(metadata.retryAfter, Date.now(), row.attempts));
    const m = metadataSchema.parse(decode(metadata.bytes));
    const candidate: Candidate = {
      id: m.id,
      threadId: m.threadId,
      labels: m.labelIds ?? [],
      messageIds: m.payload.headers.filter((h) => h.name.toLowerCase() === "message-id").map((h) => h.value),
      internalDate: Number(m.internalDate),
    };
    return m.id === candidateId && verifiesCandidate(b, candidate)
      ? { kind: "confirmed", proof: { kind: "generated_search", operationId: b.operationId, candidate } }
      : defer("ambiguous");
  } catch {
    return defer("transport");
  }
}
export async function settleRecovered(
  env: Env,
  b: Binding,
  lease: Lease,
  proof: Proof,
): Promise<"settled" | "replayed" | "conflict" | "fenced"> {
  if (proof.operationId !== b.operationId || lease.operationId !== b.operationId) return "fenced";
  try {
    let result;
    const fences = recoveryFences(env, b, lease, Date.now());
    if (proof.kind === "generated_search") {
      if (lease.mode !== "generated_search" || !verifiesCandidate(b, proof.candidate)) return "fenced";
      result = sendResult.parse({
        gmail_result_id: proof.candidate.id,
        message: { id: proof.candidate.id, thread_id: proof.candidate.threadId, label_ids: proof.candidate.labels },
      });
    } else {
      if (lease.mode !== "send_session_status") return "fenced";
      result = sendResult.parse(proof.result);
      if (b.threadId !== null && result.message.thread_id !== b.threadId) return "fenced";
      fences.push(
        assertion(
          env.DB,
          "EXISTS(SELECT 1 FROM operation_recovery WHERE operation_id=? AND session_digest=?)",
          b.operationId,
          proof.sessionDigest,
        ),
      );
    }
    return await settlePositive(env.DB, b.operationId, result, fences);
  } catch {
    return "fenced";
  }
}
