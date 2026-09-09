export const ACTIONS = [
  "read.search",
  "read.message",
  "read.attachment",
  "draft.write",
  "send.message",
  "send.draft",
  "send.forward",
  "label.manage",
  "label.apply",
  "spam.mark",
  "spam.unmark",
  "trash.move",
  "trash.restore",
  "attachment.stage_upload",
  "fs.save",
  "account.read",
  "account.connect",
  "policy.read",
  "policy.edit",
] as const;
export type Action = (typeof ACTIONS)[number];

export const MODIFIERS = ["+attachment", "+external", "+bulk", "+sensitive", "+overwrite"] as const;
export type Modifier = (typeof MODIFIERS)[number];

export const LEVELS = ["allow", "ask", "deny"] as const;
export type Level = (typeof LEVELS)[number];

export const DEFAULT_POLICY: Record<Action, Level | "browser"> = {
  "read.search": "allow",
  "read.message": "allow",
  "read.attachment": "allow",
  "draft.write": "allow",
  "send.message": "ask",
  "send.draft": "ask",
  "send.forward": "ask",
  "label.manage": "ask",
  "label.apply": "allow",
  "spam.mark": "ask",
  "spam.unmark": "allow",
  "trash.move": "ask",
  "trash.restore": "allow",
  "attachment.stage_upload": "ask",
  "fs.save": "allow",
  "account.read": "allow",
  "account.connect": "ask",
  "policy.read": "allow",
  "policy.edit": "browser",
};

/** Modifiers only raise. allow -> ask; ask and deny unchanged. */
export function raise(level: Level): Level {
  return level === "allow" ? "ask" : level;
}

/** Actions whose external side effect is journaled in `operations` (spec 3.5). */
export const JOURNALED_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  "send.message",
  "send.draft",
  "send.forward",
  "draft.write",
  "label.manage",
]);
