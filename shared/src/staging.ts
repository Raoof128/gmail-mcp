import { z } from "zod";
import { AccountAlias, MediaType, Sha256Hex } from "./schemas.ts";

export const STAGING_LIMITS = {
  fileBytes: 25 * 1024 * 1024,
  ticketMs: 60_000,
  authorityMs: 15 * 60_000,
  leaseMs: 5 * 60_000,
  bodyMs: 4 * 60_000,
  retentionMs: 7 * 86_400_000,
  pendingOwner: 16,
  pendingGlobal: 32,
  ticketsOwner: 4,
  ticketsGlobal: 8,
  uploadsOwner: 1,
  uploadsGlobal: 1,
  downloadsOwner: 2,
  downloadsGlobal: 4,
  bytesOwner: 250 * 1024 * 1024,
  bytesGlobal: 500 * 1024 * 1024,
  recordsOwner: 1000,
  recordsGlobal: 2000,
  generations: 3,
} as const;
export const TransferId = z.string().regex(/^tr_[A-Za-z0-9_-]{43}$/);
export const TicketId = z.string().regex(/^ut_[A-Za-z0-9_-]{43}$/);
export const RetryId = z.string().regex(/^rr_[A-Za-z0-9_-]{43}$/);
// Canonical protocol filenames are already normalised when they reach the authority.
const Filename = z
  .string()
  .min(1)
  .refine(
    (s) =>
      s === s.normalize("NFC") &&
      new TextEncoder().encode(s).byteLength <= 255 &&
      s !== "." &&
      s !== ".." &&
      !/[\\/\p{Cc}\p{Cf}]/u.test(s),
    "invalid canonical filename",
  );
export const UploadMetadata = z.strictObject({
  filename: Filename,
  size: z.number().int().min(0).max(STAGING_LIMITS.fileBytes),
  mime: MediaType,
  sha256: Sha256Hex,
});
export type UploadMetadata = z.infer<typeof UploadMetadata>;
const fields = { transfer_id: TransferId, account: AccountAlias, metadata: UploadMetadata };
export const TransferIntent = z.discriminatedUnion("mode", [
  z.strictObject({ ...fields, mode: z.literal("ensure") }),
  z.strictObject({ ...fields, mode: z.literal("status") }),
  z.strictObject({
    ...fields,
    mode: z.literal("retry"),
    expected_generation: z.number().int().min(1).max(3),
    retry_request_id: RetryId,
  }),
]);
export type TransferIntent = z.infer<typeof TransferIntent>;
export type TransferResult = {
  transfer_id: string;
  account: string;
  account_id: string;
  intent_hash: string;
  state: string;
  generation?: number;
  ticket_id?: string;
  ticket_expires_at?: number;
  pending_id?: string;
  approval_url?: string;
  handle?: string;
  handle_expires_at?: number;
  error?: string;
};
