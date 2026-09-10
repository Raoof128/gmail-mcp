import { StagingHandle } from "@gmail-mcp/shared/schemas";

/**
 * What the owner is shown before approving. One shape per action family; anything that does not fit
 * becomes `raw`, which the page prints in full. Plan 3's tools write payloads to this contract.
 */
export type ApprovalView =
  | {
      kind: "send";
      to: string[];
      cc: string[];
      bcc: string[];
      subject: string | null;
      body: string | null;
      handles: string[];
      draftId: string | null;
      messageId: string | null;
      includeOriginalAttachments: boolean | null;
    }
  | {
      kind: "targets";
      messageIds: string[];
      threadIds: string[];
      add: string[];
      remove: string[];
      count: number;
    }
  | { kind: "label"; op: "create" | "update" | "delete" | null; labelId: string | null; name: string | null }
  | { kind: "upload"; filename: string; size: number; mime: string }
  | { kind: "raw"; reason: string };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function approvalView(action: string, payload: unknown): ApprovalView {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  switch (action) {
    case "send.message":
    case "send.draft":
    case "send.forward": {
      const view = {
        kind: "send" as const,
        to: strings(p.to),
        cc: strings(p.cc),
        bcc: strings(p.bcc),
        subject: str(p.subject),
        body: str(p.body),
        handles: strings(p.attachments).filter((h) => StagingHandle.safeParse(h).success),
        draftId: str(p.draft_id),
        messageId: str(p.message_id),
        includeOriginalAttachments:
          typeof p.include_original_attachments === "boolean" ? p.include_original_attachments : null,
      };
      if (action === "send.draft" && !view.draftId) return { kind: "raw", reason: "send.draft without draft_id" };
      if (action === "send.forward" && !view.messageId)
        return { kind: "raw", reason: "send.forward without message_id" };
      if (action !== "send.draft" && view.to.length + view.cc.length + view.bcc.length === 0)
        return { kind: "raw", reason: "no recipients" };
      return view;
    }
    case "trash.move":
    case "trash.restore":
    case "spam.mark":
    case "spam.unmark":
    case "label.apply": {
      const view = {
        kind: "targets" as const,
        messageIds: strings(p.message_ids).concat(str(p.message_id) ? [str(p.message_id)!] : []),
        threadIds: strings(p.thread_ids).concat(str(p.thread_id) ? [str(p.thread_id)!] : []),
        add: strings(p.add).concat(strings(p.label_ids)),
        remove: strings(p.remove),
        count: 0,
      };
      view.count = view.messageIds.length + view.threadIds.length;
      if (view.count === 0) return { kind: "raw", reason: "no target" };
      if (action === "label.apply" && view.add.length + view.remove.length === 0)
        return { kind: "raw", reason: "no labels" };
      return view;
    }
    case "label.manage": {
      const op = str(p.op);
      if (op !== "create" && op !== "update" && op !== "delete") return { kind: "raw", reason: "unknown label op" };
      return { kind: "label", op, labelId: str(p.label_id), name: str(p.name) };
    }
    case "attachment.stage_upload": {
      const filename = str(p.filename);
      const mime = str(p.mime);
      return filename && mime && typeof p.size === "number"
        ? { kind: "upload", filename, size: p.size, mime }
        : { kind: "raw", reason: "upload without filename, size and mime" };
    }
    default:
      return { kind: "raw", reason: `no view for ${action}` };
  }
}
