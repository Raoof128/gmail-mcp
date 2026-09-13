import { z } from "zod";
import { ACTIONS, MODIFIERS } from "./actions.ts";

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
const FormatArg = z.union([MessageFormat, z.literal("MESSAGE_FORMAT_UNSPECIFIED")]).default("PLAIN_TEXT");
const PageLimit = z.number().int().min(1).max(50).default(20);
const PageToken = z.string().min(1).max(512).optional();
const BodyCharLimit = z.number().int().min(1).max(200_000).default(20_000);
export const SearchThreadsInput = z.object({
  account: AccountAlias.optional(),
  query: z.string().max(2048).optional(),
  limit: PageLimit,
  page_token: PageToken,
  include_spam_trash: z.boolean().default(false),
});
export const GetThreadInput = z.object({
  account: AccountAlias.optional(),
  thread_id: GmailId,
  message_format: FormatArg,
  max_messages: z.number().int().min(1).max(100).default(25),
  include_body: z.boolean().default(true),
  body_char_limit: BodyCharLimit,
  total_body_char_limit: z.number().int().min(1).max(2_000_000).default(200_000),
});
export const GetMessageInput = z.object({
  account: AccountAlias.optional(),
  message_id: GmailId,
  message_format: FormatArg,
  include_body: z.boolean().default(true),
  body_char_limit: BodyCharLimit,
});
export const ListDraftsInput = z.object({
  account: AccountAlias.optional(),
  query: z.string().max(2048).optional(),
  limit: PageLimit,
  page_token: PageToken,
});
export const GetDraftInput = z.object({
  account: AccountAlias.optional(),
  draft_id: GmailId,
  message_format: FormatArg,
  body_char_limit: BodyCharLimit,
});
export const ListLabelsInput = z.object({ account: AccountAlias.optional() });
const oneSource = (v: { attachment_id?: string | undefined; part_id?: string | undefined }) =>
  (v.attachment_id === undefined) !== (v.part_id === undefined);
const ONE_SOURCE = { message: "give attachment_id or part_id, not both" };
const DownloadAttachmentFields = {
  message_id: GmailId,
  attachment_id: z.string().min(1).max(1024).optional(),
  part_id: z.string().min(1).max(64).optional(),
};
export const DownloadAttachmentInput = z
  .object({ account: AccountAlias.optional(), ...DownloadAttachmentFields })
  .refine(oneSource, ONE_SOURCE);
/** The stored payload, which the gate strips of `account` before it journals. A refined object cannot
 * be `.omit()`ed, so the two schemas are built from one field set instead. */
export const DownloadAttachmentPayload = z.object(DownloadAttachmentFields).refine(oneSource, ONE_SOURCE);

export const Recipient = z.string().min(3).max(320);
// Coarse guard only: validateCompose owns the 500 cap and reports it as limit_exceeded.
export const Recipients = z.array(Recipient).max(2000).default([]);
const ComposeFields = {
  to: Recipients,
  cc: Recipients,
  bcc: Recipients,
  subject: z.string().max(4000).optional(),
  body: z.string().max(600_000).optional(),
  html_body: z.string().max(600_000).optional(),
  from: Recipient.optional(),
  attachments: z.array(StagingHandle).max(100).optional(),
  inline_attachments: z.array(InlineAttachment).max(50).optional(),
};
export const CreateDraftInput = z.object({
  account: AccountAlias,
  ...ComposeFields,
  reply_to_message_id: GmailId.optional(),
});
export const UpdateDraftInput = z.object({
  account: AccountAlias,
  draft_id: GmailId,
  ...ComposeFields,
  to: z.array(Recipient).max(2000).optional(),
  cc: z.array(Recipient).max(2000).optional(),
  bcc: z.array(Recipient).max(2000).optional(),
});
export const IdempotencyKey = z.string().min(1).max(128);
export const SendMessageInput = z.object({
  account: AccountAlias,
  ...ComposeFields,
  idempotency_key: IdempotencyKey.optional(),
});
export const ReplyInput = z
  .object({
    account: AccountAlias,
    message_id: GmailId,
    reply_all: z.boolean().default(false),
    ...ComposeFields,
    idempotency_key: IdempotencyKey.optional(),
  })
  .omit({ subject: true });
export const ForwardInput = z
  .object({
    account: AccountAlias,
    message_id: GmailId,
    forward_text: z.string().max(600_000).optional(),
    include_original_attachments: z.boolean().default(false),
    ...ComposeFields,
    idempotency_key: IdempotencyKey.optional(),
  })
  .omit({ subject: true, body: true });
export const SendDraftInput = z.object({
  account: AccountAlias,
  draft_id: GmailId,
  idempotency_key: IdempotencyKey.optional(),
});
