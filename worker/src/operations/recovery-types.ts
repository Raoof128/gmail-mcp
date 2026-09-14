export type UploadEndpoint = { kind: "send" } | { kind: "draft_create" } | { kind: "draft_update"; draftId: string };
export type RecoveryMode = "generated_search" | "send_session_status";
export type SendResult = {
  gmail_result_id: string;
  message: { id: string; thread_id: string; label_ids: string[] };
};
export type Binding = {
  operationId: string;
  userId: string;
  accountId: string;
  credentialVersion: number;
  executor: "send_message" | "reply" | "forward" | "send_draft";
  resultVersion: "send-v1";
  generatedMessageId: string | null;
  threadId: string | null;
  pendingId: string | null;
  startedAt: number;
  mimeLength: number | null;
  buildId: string;
  origin: string;
  audit: { action: string; modifiers: string[]; recipients: number; attachments: number };
};
export type Candidate = {
  id: string;
  threadId: string;
  labels: string[];
  messageIds: string[];
  internalDate: number;
};
export type Proof =
  | { kind: "generated_search"; operationId: string; candidate: Candidate }
  | { kind: "session_receipt"; operationId: string; sessionDigest: string; result: SendResult };
export type Observation =
  | { kind: "confirmed"; proof: Proof }
  | {
      kind: "deferred";
      retryAt: number;
      reason: "not_found" | "ambiguous" | "throttled" | "budget" | "transport" | "awaiting_final";
    }
  | { kind: "suspended"; reason: "account_changed" | "disabled" | "expired" | "manual_draft" | "invalid_evidence" };
export type SessionStatus =
  | { kind: "complete"; result: SendResult }
  | { kind: "incomplete"; nextOffset: number }
  | { kind: "awaiting_final" }
  | { kind: "unknown"; reason: "expired" | "invalid_response" };
export type Lease = {
  operationId: string;
  token: string;
  until: number;
  qualificationEpoch: string;
  mode: RecoveryMode;
};
export type Deadlines = { runUntil: number; attemptUntil: number; requestUntil: number };
export type HttpObservation =
  | { kind: "response"; status: number; bytes: Uint8Array; range: string | null; retryAfter: string | null }
  | { kind: "deferred"; retryAt: number; reason: "budget" | "transport" }
  | { kind: "suspended"; reason: "account_changed" | "disabled" | "expired" };
