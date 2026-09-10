export type ErrorCode =
  | "policy_denied"
  | "pending_approval"
  | "pending_not_approved"
  | "pending_expired"
  | "pending_replayed"
  | "payload_mismatch"
  | "delivery_unknown"
  | "idempotency_conflict"
  | "account_not_found"
  | "account_needs_reconnect"
  | "handle_invalid"
  | "handle_expired"
  | "handle_reserved"
  | "limit_exceeded"
  | "blocked_extension"
  | "invalid_address"
  | "invalid_header"
  | "gmail_error"
  | "unauthorized"
  | "forbidden"
  | "internal";

export class GmailMcpError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GmailMcpError";
  }
}
