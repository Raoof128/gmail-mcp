import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createWorker } from "../src/index";
import { FakeGoogle } from "./fake-google";
import { mintToken } from "./browser";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { callTool } from "./mcp-client";
import { testDeps, testEnv } from "./test-env";
import { approvePending } from "../src/approval/pending";
import { setPolicy } from "../src/policy/engine";

const e = testEnv();
let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
let token: string;
const gm = () => g.gmail;
const U = "owner-sub";

beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker(testDeps(g));
  await seedUserAndAccount(env.DB, { userId: U, accountId: "osm", alias: "personal", isDefault: true });
  await seedAccessToken(e, { userId: U, accountId: "osm" });
  token = (await mintToken(worker, e, g, { scope: "mcp" })).accessToken;
});

beforeEach(() => {
  gm().before = null;
});

const call = (name: string, args: Record<string, unknown>) => callTool(worker, e, token, name, args);

/**
 * Records the state of every operation row at the instant Gmail receives its first mutating request.
 * A GET cannot change the mailbox, so only the other methods are observed. The Gmail path is reached
 * through the fake's before hook, which runs ahead of the handler, so this is the state the mailbox
 * would have been mutated under.
 */
function watchFirstMutation(): { seen: { id: string; state: string }[][] } {
  const seen: { id: string; state: string }[][] = [];
  gm().before = async (req: Request) => {
    if (req.method !== "GET") {
      const rows = await env.DB.prepare("SELECT id, state FROM operations WHERE user_id = ?")
        .bind(U)
        .all<{ id: string; state: string }>();
      seen.push(rows.results);
    }
    return undefined;
  };
  return { seen };
}

describe("claimed means no external mutation could have happened", () => {
  it("a journaled send is executing, never claimed, when Gmail first sees a mutating request", async () => {
    await setPolicy(env.DB, { userId: U, accountId: "osm", action: "send.message", level: "allow" });
    const w = watchFirstMutation();
    const r = await call("send_message", {
      account: "personal",
      to: ["personal@example.test"],
      subject: "state machine",
      body: "b",
    });
    expect(r.result).toMatchObject({ status: "executed" });
    expect(w.seen.length).toBeGreaterThan(0);
    for (const snapshot of w.seen) {
      for (const row of snapshot) expect(row.state).not.toBe("claimed");
    }
    expect(w.seen[0]!.some((r) => r.state === "executing")).toBe(true);
  });

  it("a journaled draft is executing too, because it shares the send pipeline", async () => {
    const w = watchFirstMutation();
    const r = await call("create_draft", {
      account: "personal",
      to: ["personal@example.test"],
      subject: "d",
      body: "b",
    });
    expect(r.result).toMatchObject({ status: "executed" });
    expect(w.seen.length).toBeGreaterThan(0);
    for (const snapshot of w.seen) for (const row of snapshot) expect(row.state).not.toBe("claimed");
  });

  it("create_label, the one journaled label tool, is executing before its POST", async () => {
    await setPolicy(env.DB, { userId: U, accountId: "osm", action: "label.manage", level: "allow" });
    const w = watchFirstMutation();
    const r = await call("create_label", { account: "personal", display_name: "Oracle" });
    expect(r.result).toMatchObject({ status: "executed" });
    expect(w.seen.length).toBeGreaterThan(0);
    for (const snapshot of w.seen) for (const row of snapshot) expect(row.state).not.toBe("claimed");
  });
});

// The journal invariant above does not apply to these: the contract is that they open no operation at
// all. What has to hold instead is that nothing downstream assumes one exists.
describe("the intentionally non-journalled tools", () => {
  const opsFor = async (action: string) =>
    (await env.DB.prepare("SELECT count(*) AS n FROM operations WHERE user_id = ? AND action = ?")
      .bind(U, action)
      .first<{ n: number }>())!.n;

  it("label_message opens no operation row and still reports executed", async () => {
    const m = gm().seedMessage({ from: "a@x.test", to: ["me@x.test"], subject: "s", text: "t" });
    gm().labels.set("Label_osm", { id: "Label_osm", name: "Keep", type: "user" });
    const before = await opsFor("label.apply");
    const r = await call("label_message", { account: "personal", message_id: m.id, label_ids: ["Label_osm"] });
    expect(r.result).toMatchObject({ status: "executed" });
    expect(await opsFor("label.apply")).toBe(before);
  });

  it("trash_message on the approval path is given an operation by the claim, and is executing before the mutation", async () => {
    const m = gm().seedMessage({ from: "a@x.test", to: ["me@x.test"], subject: "s", text: "t" });
    const before = await opsFor("trash.move");
    const asked = await call("trash_message", { account: "personal", message_id: m.id });
    expect((asked.result as { status: string }).status).toBe("pending_approval");
    const id = (asked.result as { action_id: string }).action_id;
    expect(await approvePending(env.DB, { id, userId: U, via: "browser" })).toBe(true);

    // journal: false only governs the direct path. A claim creates an operation so that it can be
    // made once-only, and the executor must then open it: Plan 3 found exactly this family failing to.
    const w = watchFirstMutation();
    const done = await call("execute_pending", { action_id: id });
    expect(done.result).toMatchObject({ status: "executed" });
    expect(gm().messages.get(m.id)!.labelIds).toContain("TRASH");
    expect(await opsFor("trash.move")).toBe(before + 1);
    expect(w.seen.length).toBeGreaterThan(0);
    for (const snapshot of w.seen) for (const row of snapshot) expect(row.state).not.toBe("claimed");

    const replay = await call("execute_pending", { action_id: id });
    expect(JSON.stringify(replay.result)).toMatch(/pending_replayed|replay/i);
    expect(await opsFor("trash.move")).toBe(before + 1);
  });

  it("the same tool on the direct allow path opens no operation at all", async () => {
    await setPolicy(env.DB, { userId: U, accountId: "osm", action: "trash.restore", level: "allow" });
    const m = gm().seedMessage({ from: "a@x.test", to: ["me@x.test"], subject: "s", text: "t" });
    const before = await opsFor("trash.restore");
    const r = await call("untrash_message", { account: "personal", message_id: m.id });
    expect(r.result).toMatchObject({ status: "executed" });
    expect(await opsFor("trash.restore")).toBe(before);
  });

  it("every operation row that exists belongs to a journalled action or to an approval claim", async () => {
    const rows = await env.DB.prepare("SELECT DISTINCT action FROM operations WHERE user_id = ?")
      .bind(U)
      .all<{ action: string }>();
    const journalled = new Set([
      "send.message",
      "send.draft",
      "send.forward",
      "draft.write",
      "label.manage",
      "attachment.stage_upload",
    ]);
    // A claimed action may also appear, because the claim opens the operation. What must never appear
    // is an action that neither journals nor was ever approved.
    const claimable = await env.DB.prepare("SELECT DISTINCT action FROM pending_actions WHERE user_id = ?")
      .bind(U)
      .all<{ action: string }>();
    const approved = new Set(claimable.results.map((r) => r.action));
    for (const r of rows.results) expect(journalled.has(r.action) || approved.has(r.action)).toBe(true);
  });
});
