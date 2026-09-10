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
export const GmailId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
export const LabelId = GmailId;
export const LabelName = z.string().min(1).max(225);
export const LabelListVisibility = z.enum(["LABEL_SHOW", "LABEL_SHOW_IF_UNREAD", "LABEL_HIDE"]);
export const MessageListVisibility = z.enum(["SHOW", "HIDE"]);
export const LabelOption = z.enum(["TRASH", "SPAM"]);
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const MessageTargetInput = z.object({ account: AccountAlias, message_id: GmailId });
export const ThreadTargetInput = z.object({ account: AccountAlias, thread_id: GmailId });
const LabelIds = z.array(LabelId).min(1).max(100);
export const LabelMessageInput = MessageTargetInput.extend({ label_ids: LabelIds });
export const UnlabelMessageInput = LabelMessageInput;
export const LabelThreadInput = ThreadTargetInput.extend({ label_ids: LabelIds });
export const UnlabelThreadInput = LabelThreadInput;
export const UpdateMessageLabelsInput = MessageTargetInput.extend({
  add_label_ids: z.array(LabelId).max(100).default([]),
  remove_label_ids: z.array(LabelId).max(100).default([]),
})
  .refine((v) => v.add_label_ids.length + v.remove_label_ids.length > 0, {
    message: "add or remove at least one label",
  })
  .refine((v) => !v.add_label_ids.some((id) => v.remove_label_ids.includes(id)), {
    message: "a label cannot be both added and removed",
  });
export const ApplySensitiveMessageLabelInput = MessageTargetInput.extend({ label_option: LabelOption });
export const ApplySensitiveThreadLabelInput = ThreadTargetInput.extend({ label_option: LabelOption });
export const CreateLabelInput = z.object({
  account: AccountAlias,
  display_name: LabelName,
  label_list_visibility: LabelListVisibility.optional(),
  message_list_visibility: MessageListVisibility.optional(),
  text_color: HexColor.optional(),
  background_color: HexColor.optional(),
});
export const UpdateLabelInput = z.object({
  account: AccountAlias,
  label_id: LabelId,
  display_name: LabelName.optional(),
  label_list_visibility: LabelListVisibility.optional(),
  message_list_visibility: MessageListVisibility.optional(),
  text_color: HexColor.optional(),
  background_color: HexColor.optional(),
});
export const DeleteLabelInput = z.object({ account: AccountAlias, label_id: LabelId });

export const MediaType = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/);
/** 1 MiB decoded is 1 398 104 base64 characters; the cap stops a larger string before any decoder sees it. */
export const INLINE_B64_MAX = 1_400_000;
export const InlineAttachment = z.object({
  filename: z.string().min(1).max(255),
  mime: MediaType,
  content_base64: z.string().min(1).max(INLINE_B64_MAX),
});
export type InlineAttachment = z.infer<typeof InlineAttachment>;
