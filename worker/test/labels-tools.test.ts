import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { FakeGoogle } from "./fake-google";
import { mintToken } from "./browser";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { callTool } from "./mcp-client";
import { testDeps, testEnv } from "./test-env";
import { approvePending, getPending } from "../src/approval/pending";
import { setPolicy } from "../src/policy/engine";

const e = testEnv();
let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
let token: string;
const gm = () => g.gmail;

beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker(testDeps(g));
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "la", alias: "personal", isDefault: true });
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "lb", alias: "cold" });
  await seedAccessToken(e, { userId: "owner-sub", accountId: "la" });
  token = (await mintToken(worker, e, g, { scope: "mcp" })).accessToken;
});

const call = (name: string, args: Record<string, unknown>) => callTool(worker, e, token, name, args);
const opCount = async () =>
  (await env.DB.prepare("SELECT count(*) AS n FROM operations WHERE user_id = 'owner-sub'").first<any>()).n as number;

describe("label.apply", () => {
  it("label_message adds user labels (allow), echoes the message, and creates no operation row", async () => {
    const m = gm().seedMessage({ from: "a@x.test", to: ["me@x.test"], subject: "s1", text: "t" });
    gm().labels.set("Label_1", { id: "Label_1", name: "Receipts", type: "user" });
    const before = await opCount();
    const r = await call("label_message", { account: "personal", message_id: m.id, label_ids: ["Label_1"] });
    expect(r.result).toMatchObject({
      status: "executed",
      account: "personal",
      message: { id: m.id, label_ids: expect.arrayContaining(["Label_1", "INBOX"]) },
    });
    expect(gm().messages.get(m.id)!.labelIds).toContain("Label_1");
    expect(await opCount()).toBe(before);
    const rows = await env.DB.prepare(
      "SELECT phase, decision FROM audit_log WHERE user_id='owner-sub' AND tool='label_message' ORDER BY id DESC LIMIT 2",
    ).all<any>();
    expect(rows.results.map((x) => [x.phase, x.decision]).reverse()).toEqual([
      ["intent", "allow"],
      ["outcome", "executed"],
    ]);
  });
  it("a system label raises +sensitive to ask; TRASH and SPAM are refused outright", async () => {
    const m = gm().seedMessage({ from: "a@x.test", to: ["me@x.test"], subject: "s2", text: "t" });
    const r = await call("label_message", { account: "personal", message_id: m.id, label_ids: ["STARRED"] });
    expect(r.result).toMatchObject({ status: "pending_approval", action: "label.apply", modifiers: ["+sensitive"] });
    expect(gm().messages.get(m.id)!.labelIds).not.toContain("STARRED");
    expect(JSON.parse((await getPending(env.DB, r.result.action_id, "owner-sub"))!.payload_json!)).toEqual({
      add: ["STARRED"],
      message_id: m.id,
      remove: [],
      tool: "label_message",
      v: 1,
    });
    expect(
      (await call("label_message", { account: "personal", message_id: m.id, label_ids: ["TRASH"] })).result,
    ).toMatchObject({ error: "forbidden" });
  });
  it("unlabel, thread variants and update_message_labels reach Gmail with add and remove; overlapping sets are refused", async () => {
    const m = gm().seedMessage({
      from: "a@x.test",
      to: ["me@x.test"],
      subject: "s3",
      text: "t",
      labelIds: ["INBOX", "Label_1", "Label_2"],
    });
    gm().labels.set("Label_2", { id: "Label_2", name: "Two", type: "user" });
    expect(
      (await call("unlabel_message", { account: "personal", message_id: m.id, label_ids: ["Label_1"] })).result.status,
    ).toBe("executed");
    expect(gm().messages.get(m.id)!.labelIds).not.toContain("Label_1");
    expect(
      (await call("label_thread", { account: "personal", thread_id: m.threadId, label_ids: ["Label_1"] })).result,
    ).toMatchObject({ status: "executed", thread: { id: m.threadId } });
    expect(
      (await call("unlabel_thread", { account: "personal", thread_id: m.threadId, label_ids: ["Label_1", "Label_2"] }))
        .result.status,
    ).toBe("executed");
    await call("label_message", { account: "personal", message_id: m.id, label_ids: ["Label_1"] });
    const r = await call("update_message_labels", {
      account: "personal",
      message_id: m.id,
      add_label_ids: ["Label_2"],
      remove_label_ids: ["Label_1"],
    });
    expect(r.result.status).toBe("executed");
    expect(gm().messages.get(m.id)!.labelIds).toEqual(["INBOX", "Label_2"]);
    // Spec 2.2 reads the target label, not the direction, so archiving by removing INBOX is +sensitive.
    const archive = await call("update_message_labels", {
      account: "personal",
      message_id: m.id,
      remove_label_ids: ["INBOX"],
    });
    expect(archive.result).toMatchObject({ status: "pending_approval", modifiers: ["+sensitive"] });
    const empty = await call("update_message_labels", { account: "personal", message_id: m.id });
    expect(empty.isError || empty.error).toBeTruthy();
    const overlap = await call("update_message_labels", {
      account: "personal",
      message_id: m.id,
      add_label_ids: ["Label_2"],
      remove_label_ids: ["Label_2"],
    });
    expect(overlap.isError || overlap.error).toBeTruthy();
  });
  it("apply_sensitive_* carry +sensitive and, once approved and executed, trash or spam the target", async () => {
    const m = gm().seedMessage({ from: "a@x.test", to: ["me@x.test"], subject: "s4", text: "t" });
    const r = await call("apply_sensitive_message_label", {
      account: "personal",
      message_id: m.id,
      label_option: "TRASH",
    });
    expect(r.result).toMatchObject({ status: "pending_approval", modifiers: ["+sensitive"] });
    await approvePending(env.DB, { id: r.result.action_id, userId: "owner-sub", via: "browser" });
    const done = await call("execute_pending", { action_id: r.result.action_id });
    expect(done.result).toMatchObject({ status: "executed", action_id: r.result.action_id });
    expect(gm().messages.get(m.id)!.labelIds).toContain("TRASH");
    expect(
      (await call("apply_sensitive_thread_label", { account: "personal", thread_id: m.threadId, label_option: "SPAM" }))
        .result.status,
    ).toBe("pending_approval");
  });
});

describe("spam and trash", () => {
  it("mark spam asks by default; unmark spam is allowed; the wire shapes are modify calls", async () => {
    const m = gm().seedMessage({
      from: "a@x.test",
      to: ["me@x.test"],
      subject: "s5",
      text: "t",
      labelIds: ["INBOX", "SPAM"],
    });
    expect((await call("mark_message_spam", { account: "personal", message_id: m.id })).result.status).toBe(
      "pending_approval",
    );
    const u = await call("unmark_message_spam", { account: "personal", message_id: m.id });
    expect(u.result.status).toBe("executed");
    expect(gm().messages.get(m.id)!.labelIds).not.toContain("SPAM");
    const last = gm().requests.at(-1)!;
    expect(last.url).toContain(`/messages/${m.id}/modify`);
    expect(await last.clone().json()).toEqual({ addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] });
    expect((await call("mark_thread_spam", { account: "personal", thread_id: m.threadId })).result.status).toBe(
      "pending_approval",
    );
    expect((await call("unmark_thread_spam", { account: "personal", thread_id: m.threadId })).result.status).toBe(
      "executed",
    );
  });
  it("trash asks by default and executes once allowed; untrash is allowed", async () => {
    const m = gm().seedMessage({ from: "a@x.test", to: ["me@x.test"], subject: "s6", text: "t" });
    expect((await call("trash_message", { account: "personal", message_id: m.id })).result.status).toBe(
      "pending_approval",
    );
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "la", action: "trash.move", level: "allow" });
    expect((await call("trash_message", { account: "personal", message_id: m.id })).result.status).toBe("executed");
    expect(gm().requests.at(-1)!.url).toContain(`/messages/${m.id}/trash`);
    expect(gm().messages.get(m.id)!.labelIds).toContain("TRASH");
    expect((await call("untrash_message", { account: "personal", message_id: m.id })).result.status).toBe("executed");
    expect(gm().messages.get(m.id)!.labelIds).not.toContain("TRASH");
    expect((await call("trash_thread", { account: "personal", thread_id: m.threadId })).result.status).toBe("executed");
    expect((await call("untrash_thread", { account: "personal", thread_id: m.threadId })).result.status).toBe(
      "executed",
    );
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "la", action: "trash.move", level: "ask" });
  });
  it("a write without an explicit account is a schema error, never a guess", async () => {
    const r = await call("trash_message", { message_id: "m1" });
    expect(r.isError || r.error).toBeTruthy();
  });
  it("an account without credentials answers connect_required and never reaches Gmail", async () => {
    const before = gm().requests.length;
    const r = await call("untrash_message", { account: "cold", message_id: "m1" });
    expect(r.result).toMatchObject({ status: "connect_required", account: "cold" });
    expect(r.result.url).toMatch(/^https:\/\/gmail-mcp\.example\.workers\.dev\/connect\?alias=cold&e=/);
    expect(gm().requests.length).toBe(before);
  });
  it("Gmail's error is surfaced verbatim and the call is audited as failed", async () => {
    const r = await call("untrash_message", { account: "personal", message_id: "does-not-exist" });
    expect(r.result).toMatchObject({ error: "gmail_error", details: { status: 404 } });
    expect(r.result.message).toContain("Requested entity was not found.");
    const row = await env.DB.prepare(
      "SELECT phase, decision FROM audit_log WHERE user_id = 'owner-sub' AND tool = 'untrash_message' ORDER BY id DESC LIMIT 1",
    ).first<any>();
    expect(row).toEqual({ phase: "outcome", decision: "failed" });
  });
});

describe("label.manage", () => {
  it("create_label asks by default, executes through the browser approval, and journals with the label id as the result", async () => {
    const r = await call("create_label", {
      account: "personal",
      display_name: "Uni/2026/Thesis",
      label_list_visibility: "LABEL_SHOW",
    });
    expect(r.result).toMatchObject({ status: "pending_approval", action: "label.manage" });
    expect(JSON.parse((await getPending(env.DB, r.result.action_id, "owner-sub"))!.payload_json!)).toMatchObject({
      op: "create",
      name: "Uni/2026/Thesis",
      tool: "create_label",
      v: 1,
    });
    await approvePending(env.DB, { id: r.result.action_id, userId: "owner-sub", via: "browser" });
    const done = await call("execute_pending", { action_id: r.result.action_id });
    expect(done.result).toMatchObject({
      status: "executed",
      label: { name: "Uni/2026/Thesis", label_list_visibility: "LABEL_SHOW" },
    });
    const op = await env.DB.prepare("SELECT state, gmail_result_id FROM operations WHERE id = ?")
      .bind(done.result.operation_id)
      .first<any>();
    expect(op).toEqual({ state: "executed", gmail_result_id: done.result.label.id });
    expect((await call("execute_pending", { action_id: r.result.action_id })).result.error).toBe("pending_replayed");
  });
  it("a Gmail 409 on create is failed_safe with the message verbatim, not delivery_unknown", async () => {
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "la", action: "label.manage", level: "allow" });
    gm().labels.set("Label_dup", { id: "Label_dup", name: "Dup", type: "user" });
    const r = await call("create_label", { account: "personal", display_name: "Dup" });
    expect(r.result).toMatchObject({ error: "gmail_error", details: { status: 409 } });
    expect(
      (
        await env.DB.prepare(
          "SELECT state FROM operations WHERE user_id='owner-sub' ORDER BY created_at DESC LIMIT 1",
        ).first<any>()
      ).state,
    ).toBe("failed_safe");
  });
  it("update_label and delete_label do not journal; system labels are refused before Gmail; colours pass through", async () => {
    const created = await call("create_label", {
      account: "personal",
      display_name: "Temp",
      text_color: "#000000",
      background_color: "#ffffff",
    });
    expect(created.result.label.color).toEqual({ text_color: "#000000", background_color: "#ffffff" });
    const id = created.result.label.id as string;
    const before = await opCount();
    const up = await call("update_label", {
      account: "personal",
      label_id: id,
      display_name: "Temp2",
      message_list_visibility: "HIDE",
    });
    expect(up.result.label).toMatchObject({ id, name: "Temp2", message_list_visibility: "HIDE" });
    expect(gm().labels.get(id)).toMatchObject({ name: "Temp2", messageListVisibility: "hide" });
    expect((await call("delete_label", { account: "personal", label_id: "INBOX" })).result).toMatchObject({
      error: "forbidden",
    });
    expect((await call("delete_label", { account: "personal", label_id: id })).result).toMatchObject({
      status: "executed",
      deleted: id,
    });
    expect(gm().labels.has(id)).toBe(false);
    expect(await opCount()).toBe(before);
    await setPolicy(env.DB, { userId: "owner-sub", accountId: "la", action: "label.manage", level: "ask" });
  });
});
