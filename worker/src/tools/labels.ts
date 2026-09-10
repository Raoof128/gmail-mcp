import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { GmailMcpError } from "@gmail-mcp/shared/errors";
import {
  ApplySensitiveMessageLabelInput,
  ApplySensitiveThreadLabelInput,
  CreateLabelInput,
  DeleteLabelInput,
  LabelMessageInput,
  LabelThreadInput,
  MessageTargetInput,
  ThreadTargetInput,
  UnlabelMessageInput,
  UnlabelThreadInput,
  UpdateLabelInput,
  UpdateMessageLabelsInput,
} from "@gmail-mcp/shared/schemas";
import type { Env } from "../env";
import type { Deps } from "../deps";
import { gmailJson } from "../google/gmail";
import type { GmailLabel } from "../google/messages";
import { beginOperation } from "../operations/journal";
import { defineTool, type Plan } from "./define";
import type { ExecRun, ToolContext } from "./gate";

export const isSystemLabel = (id: string): boolean => /^[A-Z][A-Z0-9_]*$/.test(id);
const SENSITIVE = new Set(["TRASH", "SPAM"]);

const LIST_VIS: Record<string, string> = {
  LABEL_SHOW: "labelShow",
  LABEL_SHOW_IF_UNREAD: "labelShowIfUnread",
  LABEL_HIDE: "labelHide",
};
const MSG_VIS: Record<string, string> = { SHOW: "show", HIDE: "hide" };
const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]));
const LIST_VIS_BACK = invert(LIST_VIS);
const MSG_VIS_BACK = invert(MSG_VIS);

export function labelView(l: GmailLabel) {
  return {
    id: l.id,
    name: l.name,
    type: l.type ?? "user",
    ...(l.labelListVisibility
      ? { label_list_visibility: LIST_VIS_BACK[l.labelListVisibility] ?? l.labelListVisibility }
      : {}),
    ...(l.messageListVisibility
      ? { message_list_visibility: MSG_VIS_BACK[l.messageListVisibility] ?? l.messageListVisibility }
      : {}),
    ...(l.color ? { color: { text_color: l.color.textColor, background_color: l.color.backgroundColor } } : {}),
    ...(l.messagesTotal !== undefined
      ? { messages_total: l.messagesTotal, messages_unread: l.messagesUnread ?? 0 }
      : {}),
  };
}

type Modified = { id: string; threadId: string; labelIds?: string[] };
const messageOut = (m: Modified) => ({ message: { id: m.id, thread_id: m.threadId, label_ids: m.labelIds ?? [] } });
const threadOut = (t: { id: string; messages?: Modified[] }) => ({
  thread: { id: t.id, messages: (t.messages ?? []).map((m) => ({ id: m.id, label_ids: m.labelIds ?? [] })) },
});
const acct = (run: ExecRun) => ({ userId: run.userId, accountId: run.account.id });

/**
 * Spec 3.5 step 3. These tools do not journal, so most runs have no operation, but one exists whenever
 * the run came through an approval claim, and it must be open before Gmail can change.
 */
const open = async (env: Env, run: ExecRun): Promise<void> => {
  if (run.operationId) await beginOperation(env.DB, run.operationId);
};

async function modifyMessage(env: Env, deps: Deps, run: ExecRun, id: string, add: string[], remove: string[]) {
  await open(env, run);
  return messageOut(
    await gmailJson<Modified>(env, deps, acct(run), {
      method: "POST",
      path: `messages/${encodeURIComponent(id)}/modify`,
      json: { addLabelIds: add, removeLabelIds: remove },
      retry: "safe",
    }),
  );
}
async function modifyThread(env: Env, deps: Deps, run: ExecRun, id: string, add: string[], remove: string[]) {
  await open(env, run);
  return threadOut(
    await gmailJson<{ id: string; messages?: Modified[] }>(env, deps, acct(run), {
      method: "POST",
      path: `threads/${encodeURIComponent(id)}/modify`,
      json: { addLabelIds: add, removeLabelIds: remove },
      retry: "safe",
    }),
  );
}
async function postMessage(env: Env, deps: Deps, run: ExecRun, id: string, verb: "trash" | "untrash") {
  await open(env, run);
  return messageOut(
    await gmailJson<Modified>(env, deps, acct(run), {
      method: "POST",
      path: `messages/${encodeURIComponent(id)}/${verb}`,
      retry: "safe",
    }),
  );
}
async function postThread(env: Env, deps: Deps, run: ExecRun, id: string, verb: "trash" | "untrash") {
  await open(env, run);
  return threadOut(
    await gmailJson<{ id: string; messages?: Modified[] }>(env, deps, acct(run), {
      method: "POST",
      path: `threads/${encodeURIComponent(id)}/${verb}`,
      retry: "safe",
    }),
  );
}

/** label_* and unlabel_* refuse TRASH and SPAM: those go through the sensitive tools, which say what they do. */
function refuseSensitive(ids: string[]): void {
  const hit = ids.find((id) => SENSITIVE.has(id));
  if (hit)
    throw new GmailMcpError("forbidden", `forbidden: use apply_sensitive_* or the trash and spam tools for ${hit}`);
}
const sensitiveModifiers = (ids: string[]): Plan["modifiers"] => (ids.some(isSystemLabel) ? ["+sensitive"] : []);

/** A plan for a tool whose payload is fixed at plan time and that writes nothing before execution. */
const simple = (
  payload: Record<string, unknown>,
  modifiers: Plan["modifiers"],
  summary: string,
  ids: string[],
): Promise<Plan> =>
  Promise.resolve({
    modifiers,
    summary,
    facts: { ids },
    build: () => Promise.resolve({ payload, handles: [] }),
  });

const apply = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

export function registerLabelTools(
  server: McpServer,
  toolContext: (ctx: ServerContext) => ToolContext,
  env: Env,
): void {
  defineTool(server, toolContext, env, {
    name: "label_message",
    version: 1,
    description: "Add labels to a message. TRASH and SPAM are refused here; use the sensitive tools.",
    input: LabelMessageInput,
    annotations: apply,
    action: "label.apply",
    journal: false,
    plan: (_e, _t, _a, args) => {
      refuseSensitive(args.label_ids);
      return simple(
        { message_id: args.message_id, add: args.label_ids, remove: [] },
        sensitiveModifiers(args.label_ids),
        `Add ${args.label_ids.join(", ")} to message ${args.message_id}`,
        [args.message_id],
      );
    },
    execute: async (e, d, run) => {
      const p = run.payload as { message_id: string; add: string[]; remove: string[] };
      return modifyMessage(e, d, run, p.message_id, p.add, p.remove);
    },
  });
  defineTool(server, toolContext, env, {
    name: "unlabel_message",
    version: 1,
    description: "Remove labels from a message.",
    input: UnlabelMessageInput,
    annotations: destructive,
    action: "label.apply",
    journal: false,
    plan: (_e, _t, _a, args) => {
      refuseSensitive(args.label_ids);
      return simple(
        { message_id: args.message_id, add: [], remove: args.label_ids },
        sensitiveModifiers(args.label_ids),
        `Remove ${args.label_ids.join(", ")} from message ${args.message_id}`,
        [args.message_id],
      );
    },
    execute: async (e, d, run) => {
      const p = run.payload as { message_id: string; add: string[]; remove: string[] };
      return modifyMessage(e, d, run, p.message_id, p.add, p.remove);
    },
  });
  defineTool(server, toolContext, env, {
    name: "label_thread",
    version: 1,
    description: "Add labels to every message in a thread. TRASH and SPAM are refused here.",
    input: LabelThreadInput,
    annotations: apply,
    action: "label.apply",
    journal: false,
    plan: (_e, _t, _a, args) => {
      refuseSensitive(args.label_ids);
      return simple(
        { thread_id: args.thread_id, add: args.label_ids, remove: [] },
        sensitiveModifiers(args.label_ids),
        `Add ${args.label_ids.join(", ")} to thread ${args.thread_id}`,
        [args.thread_id],
      );
    },
    execute: async (e, d, run) => {
      const p = run.payload as { thread_id: string; add: string[]; remove: string[] };
      return modifyThread(e, d, run, p.thread_id, p.add, p.remove);
    },
  });
  defineTool(server, toolContext, env, {
    name: "unlabel_thread",
    version: 1,
    description: "Remove labels from every message in a thread.",
    input: UnlabelThreadInput,
    annotations: destructive,
    action: "label.apply",
    journal: false,
    plan: (_e, _t, _a, args) => {
      refuseSensitive(args.label_ids);
      return simple(
        { thread_id: args.thread_id, add: [], remove: args.label_ids },
        sensitiveModifiers(args.label_ids),
        `Remove ${args.label_ids.join(", ")} from thread ${args.thread_id}`,
        [args.thread_id],
      );
    },
    execute: async (e, d, run) => {
      const p = run.payload as { thread_id: string; add: string[]; remove: string[] };
      return modifyThread(e, d, run, p.thread_id, p.add, p.remove);
    },
  });
  defineTool(server, toolContext, env, {
    name: "update_message_labels",
    version: 1,
    description: "Add and remove labels on one message in one call.",
    input: UpdateMessageLabelsInput,
    annotations: destructive,
    action: "label.apply",
    journal: false,
    plan: (_e, _t, _a, args) => {
      const all = [...args.add_label_ids, ...args.remove_label_ids];
      refuseSensitive(all);
      return simple(
        { message_id: args.message_id, add: args.add_label_ids, remove: args.remove_label_ids },
        sensitiveModifiers(all),
        `Message ${args.message_id}: add ${args.add_label_ids.join(", ") || "none"}, remove ${args.remove_label_ids.join(", ") || "none"}`,
        [args.message_id],
      );
    },
    execute: async (e, d, run) => {
      const p = run.payload as { message_id: string; add: string[]; remove: string[] };
      return modifyMessage(e, d, run, p.message_id, p.add, p.remove);
    },
  });
  defineTool(server, toolContext, env, {
    name: "apply_sensitive_message_label",
    version: 1,
    description: "Move one message to Trash or mark it as spam. Always carries +sensitive.",
    input: ApplySensitiveMessageLabelInput,
    annotations: destructive,
    action: "label.apply",
    journal: false,
    plan: (_e, _t, _a, args) =>
      simple(
        { message_id: args.message_id, add: [args.label_option], remove: ["INBOX"] },
        ["+sensitive"],
        `${args.label_option} message ${args.message_id}`,
        [args.message_id],
      ),
    execute: async (e, d, run) => {
      const p = run.payload as { message_id: string; add: string[]; remove: string[] };
      return p.add[0] === "TRASH"
        ? postMessage(e, d, run, p.message_id, "trash")
        : modifyMessage(e, d, run, p.message_id, p.add, p.remove);
    },
  });
  defineTool(server, toolContext, env, {
    name: "apply_sensitive_thread_label",
    version: 1,
    description: "Move one thread to Trash or mark it as spam. Always carries +sensitive.",
    input: ApplySensitiveThreadLabelInput,
    annotations: destructive,
    action: "label.apply",
    journal: false,
    plan: (_e, _t, _a, args) =>
      simple(
        { thread_id: args.thread_id, add: [args.label_option], remove: ["INBOX"] },
        ["+sensitive"],
        `${args.label_option} thread ${args.thread_id}`,
        [args.thread_id],
      ),
    execute: async (e, d, run) => {
      const p = run.payload as { thread_id: string; add: string[]; remove: string[] };
      return p.add[0] === "TRASH"
        ? postThread(e, d, run, p.thread_id, "trash")
        : modifyThread(e, d, run, p.thread_id, p.add, p.remove);
    },
  });

  const spam = (name: string, target: "message" | "thread", mark: boolean) =>
    defineTool(server, toolContext, env, {
      name,
      version: 1,
      description: `${mark ? "Mark" : "Unmark"} one ${target} as spam.`,
      input: target === "message" ? MessageTargetInput : ThreadTargetInput,
      annotations: { readOnlyHint: false, destructiveHint: mark, openWorldHint: false },
      action: mark ? "spam.mark" : "spam.unmark",
      journal: false,
      plan: (_e, _t, _a, args) => {
        const id =
          target === "message"
            ? (args as { message_id: string }).message_id
            : (args as { thread_id: string }).thread_id;
        return simple(
          { [`${target}_id`]: id, add: mark ? ["SPAM"] : ["INBOX"], remove: mark ? ["INBOX"] : ["SPAM"] },
          [],
          `${mark ? "Mark" : "Unmark"} spam: ${target} ${id}`,
          [id],
        );
      },
      execute: async (e, d, run) => {
        const p = run.payload as { message_id?: string; thread_id?: string; add: string[]; remove: string[] };
        return target === "message"
          ? modifyMessage(e, d, run, p.message_id!, p.add, p.remove)
          : modifyThread(e, d, run, p.thread_id!, p.add, p.remove);
      },
    });
  spam("mark_message_spam", "message", true);
  spam("mark_thread_spam", "thread", true);
  spam("unmark_message_spam", "message", false);
  spam("unmark_thread_spam", "thread", false);

  const trash = (name: string, target: "message" | "thread", move: boolean) =>
    defineTool(server, toolContext, env, {
      name,
      version: 1,
      description: `${move ? "Move" : "Restore"} one ${target} ${move ? "to" : "from"} Trash.`,
      input: target === "message" ? MessageTargetInput : ThreadTargetInput,
      annotations: { readOnlyHint: false, destructiveHint: move, openWorldHint: false },
      action: move ? "trash.move" : "trash.restore",
      journal: false,
      plan: (_e, _t, _a, args) => {
        const id =
          target === "message"
            ? (args as { message_id: string }).message_id
            : (args as { thread_id: string }).thread_id;
        return simple(
          { [`${target}_id`]: id, op: move ? "trash" : "untrash" },
          [],
          `${move ? "Trash" : "Untrash"} ${target} ${id}`,
          [id],
        );
      },
      execute: async (e, d, run) => {
        const p = run.payload as { message_id?: string; thread_id?: string; op: "trash" | "untrash" };
        return target === "message"
          ? postMessage(e, d, run, p.message_id!, p.op)
          : postThread(e, d, run, p.thread_id!, p.op);
      },
    });
  trash("trash_message", "message", true);
  trash("trash_thread", "thread", true);
  trash("untrash_message", "message", false);
  trash("untrash_thread", "thread", false);

  const labelBody = (a: {
    display_name?: string | undefined;
    label_list_visibility?: string | undefined;
    message_list_visibility?: string | undefined;
    text_color?: string | undefined;
    background_color?: string | undefined;
  }) => ({
    ...(a.display_name !== undefined ? { name: a.display_name } : {}),
    ...(a.label_list_visibility ? { labelListVisibility: LIST_VIS[a.label_list_visibility] } : {}),
    ...(a.message_list_visibility ? { messageListVisibility: MSG_VIS[a.message_list_visibility] } : {}),
    ...(a.text_color && a.background_color
      ? { color: { textColor: a.text_color, backgroundColor: a.background_color } }
      : {}),
  });
  const colourPair = (a: { text_color?: string | undefined; background_color?: string | undefined }) => {
    if ((a.text_color === undefined) !== (a.background_color === undefined))
      throw new GmailMcpError("invalid_header", "invalid_header: text_color and background_color go together");
  };
  defineTool(server, toolContext, env, {
    name: "create_label",
    version: 1,
    description:
      "Create a label. Nest with '/'. The name is sent as given; Gmail decides whether a missing parent is acceptable.",
    input: CreateLabelInput,
    annotations: apply,
    action: "label.manage",
    journal: true,
    plan: (_e, _t, _a, args) => {
      colourPair(args);
      const { account: _account, ...rest } = args;
      return simple({ op: "create", name: args.display_name, ...rest }, [], `Create label ${args.display_name}`, []);
    },
    execute: async (e, d, run) => {
      const p = CreateLabelInput.omit({ account: true }).parse(run.payload);
      if (!run.operationId) throw new GmailMcpError("internal", "label.manage create runs with an operation");
      // The one request that changes Gmail comes after the operation is executing, and there is no other.
      await beginOperation(e.DB, run.operationId);
      const label = await gmailJson<GmailLabel>(e, d, acct(run), {
        method: "POST",
        path: "labels",
        json: labelBody(p),
        retry: "none",
      });
      return { gmail_result_id: label.id, label: labelView(label) };
    },
  });
  defineTool(server, toolContext, env, {
    name: "update_label",
    version: 1,
    description: "Rename a label or change its visibility or colour.",
    input: UpdateLabelInput,
    annotations: apply,
    action: "label.manage",
    journal: false,
    plan: (_e, _t, _a, args) => {
      if (isSystemLabel(args.label_id))
        throw new GmailMcpError("forbidden", "forbidden: system labels cannot be changed");
      colourPair(args);
      const { account: _account, ...rest } = args;
      return simple({ op: "update", name: args.display_name ?? null, ...rest }, [], `Update label ${args.label_id}`, [
        args.label_id,
      ]);
    },
    execute: async (e, d, run) => {
      const p = UpdateLabelInput.omit({ account: true }).parse(run.payload);
      const label = await gmailJson<GmailLabel>(e, d, acct(run), {
        method: "PATCH",
        path: `labels/${encodeURIComponent(p.label_id)}`,
        json: labelBody(p),
        retry: "safe",
      });
      return { label: labelView(label) };
    },
  });
  defineTool(server, toolContext, env, {
    name: "delete_label",
    version: 1,
    description: "Delete a label definition. Messages keep their other labels. System labels are refused.",
    input: DeleteLabelInput,
    annotations: destructive,
    action: "label.manage",
    journal: false,
    plan: (_e, _t, _a, args) => {
      if (isSystemLabel(args.label_id))
        throw new GmailMcpError("forbidden", "forbidden: system labels cannot be deleted");
      return simple({ op: "delete", label_id: args.label_id }, [], `Delete label ${args.label_id}`, [args.label_id]);
    },
    execute: async (e, d, run) => {
      const p = DeleteLabelInput.omit({ account: true }).parse(run.payload);
      await gmailJson<undefined>(e, d, acct(run), {
        method: "DELETE",
        path: `labels/${encodeURIComponent(p.label_id)}`,
        retry: "safe",
      });
      return { deleted: p.label_id };
    },
  });
}
