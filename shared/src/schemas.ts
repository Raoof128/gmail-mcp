import { z } from "zod";
import { ACTIONS, MODIFIERS } from "./actions";

export const AccountAlias = z.string().regex(/^[a-z0-9_-]{1,32}$/);
export const StagingHandle = z.string().regex(/^sh_[A-Za-z0-9_-]{43}$/);
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const StagingHandleResponse = z.object({
  handle: StagingHandle,
  account: AccountAlias,
  filename: z.string().min(1).max(255),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: Sha256Hex,
  expires_at: z.iso.datetime(),
});
export type StagingHandleResponse = z.infer<typeof StagingHandleResponse>;

export const PendingApprovalResult = z.object({
  status: z.literal("pending_approval"),
  action_id: z.string().regex(/^pa_[A-Za-z0-9_-]{22}$/),
  action: z.enum(ACTIONS),
  modifiers: z.array(z.enum(MODIFIERS)),
  account: AccountAlias,
  summary: z.string(),
  approval: z.object({ mode: z.literal("url"), url: z.url() }),
  expires_at: z.iso.datetime(),
});
export type PendingApprovalResult = z.infer<typeof PendingApprovalResult>;

export const UploadIntent = z.object({
  account: AccountAlias,
  filename: z.string().min(1).max(255),
  size: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024),
  mime: z.string().min(1),
  sha256: Sha256Hex,
  pending_id: z
    .string()
    .regex(/^pa_[A-Za-z0-9_-]{22}$/)
    .optional(),
});
export type UploadIntent = z.infer<typeof UploadIntent>;

export const MESSAGE_FORMATS = ["MINIMAL", "METADATA_ONLY", "PLAIN_TEXT", "FULL_CONTENT", "RAW"] as const;
export const MessageFormat = z.enum(MESSAGE_FORMATS);
export type MessageFormat = z.infer<typeof MessageFormat>;
