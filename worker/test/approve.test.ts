import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createWorker } from "../src/index";
import { Browser, csrfFrom } from "./browser";
import { FakeGoogle } from "./fake-google";
import { testEnv, testDeps } from "./test-env";
import { seedUserAndAccount } from "./fixtures";
import { createPending } from "../src/approval/pending";
import { approvalView } from "../src/approval/view";

let g: FakeGoogle;
let worker: ReturnType<typeof createWorker>;
beforeAll(async () => {
  g = await FakeGoogle.create();
  worker = createWorker(testDeps(g));
  await seedUserAndAccount(env.DB, { userId: "owner-sub", accountId: "apa", alias: "personal", isDefault: true });
  await seedUserAndAccount(env.DB, { userId: "other-owner", accountId: "apb", alias: "personal", isDefault: true });
  await env.DB.prepare(
    "INSERT INTO staging_objects (handle, user_id, account_id, direction, r2_key, filename, mime, size, sha256, created_at, expires_at) VALUES (?, 'owner-sub', 'apa', 'upload', 'k', 'thesis.pdf', 'application/pdf', 2200000, ?, ?, ?)",
  )
    .bind("sh_" + "a".repeat(43), "0".repeat(64), Date.now(), Date.now() + 600_000)
    .run();
});

async function owner() {
  const b = new Browser(worker, testEnv());
  await b.login(g, { sub: "owner-sub", email: "owner@example.test" });
  return b;
}

const payload = {
  to: ["prof@uni.edu.au"],
  cc: ["cc@uni.edu.au"],
  bcc: ["hidden@example.test"],
  subject: "Thesis draft \u202Efdp.exe",
  body: 'Hello <a href="https://evil.test">click</a>\n' + "x".repeat(5000),
  attachments: ["sh_" + "a".repeat(43)],
};

describe("approval views", () => {
  it("builds a typed view per action and falls back to raw for anything else", () => {
    const send = approvalView("send.message", payload);
    expect(send.kind).toBe("send");
    if (send.kind === "send") {
      expect(send.to).toEqual(["prof@uni.edu.au"]);
      expect(send.cc).toEqual(["cc@uni.edu.au"]);
      expect(send.bcc).toEqual(["hidden@example.test"]);
    }
    const trash = approvalView("trash.move", { message_ids: ["m1", "m2"] });
    expect(trash).toMatchObject({ kind: "targets", messageIds: ["m1", "m2"], count: 2 });
    const label = approvalView("label.apply", { thread_ids: ["t1"], add: ["Label_3"], remove: ["INBOX"] });
    expect(label).toMatchObject({ kind: "targets", threadIds: ["t1"], add: ["Label_3"], remove: ["INBOX"], count: 1 });
    expect(approvalView("label.manage", { op: "delete", label_id: "Label_9" })).toMatchObject({
      kind: "label",
      op: "delete",
      labelId: "Label_9",
    });
    expect(
      approvalView("attachment.stage_upload", { filename: "a.pdf", size: 10, mime: "application/pdf" }),
    ).toMatchObject({ kind: "upload", filename: "a.pdf" });
    expect(
      approvalView("send.forward", { message_id: "m9", to: ["x@y.test"], include_original_attachments: true }),
    ).toMatchObject({ kind: "send", messageId: "m9", includeOriginalAttachments: true });
    expect(approvalView("trash.move", { weird: 1 })).toMatchObject({ kind: "raw" });
    expect(approvalView("something.new", { a: 1 })).toMatchObject({ kind: "raw" });
  });
});

describe("approval page", () => {
  it("shows what a trash, label and forward action would touch, and the whole payload for an unknown shape", async () => {
    const b = await owner();
    const trash = await createPending(env.DB, {
      userId: "owner-sub",
      accountId: "apa",
      action: "trash.move",
      modifiers: [],
      payload: { message_ids: ["18fa<b>", "18fb"] },
      summary: "s",
    });
    const t = await (await b.get(`/approve/${trash.id}`)).text();
    expect(t).toContain("2 message(s)");
    expect(t).toContain("18fa&lt;b&gt;");
    expect(t).toContain("18fb");
    const label = await createPending(env.DB, {
      userId: "owner-sub",
      accountId: "apa",
      action: "label.apply",
      modifiers: ["+sensitive"],
      payload: { thread_ids: ["t1"], add: ["Label_3"] },
      summary: "s",
    });
    const l = await (await b.get(`/approve/${label.id}`)).text();
    expect(l).toContain("Label_3");
    expect(l).toContain("1 thread(s)");
    const fwd = await createPending(env.DB, {
      userId: "owner-sub",
      accountId: "apa",
      action: "send.forward",
      modifiers: [],
      payload: { message_id: "m9", to: ["a@x.test"], bcc: ["b@x.test"], include_original_attachments: true },
      summary: "s",
    });
    const f = await (await b.get(`/approve/${fwd.id}`)).text();
    expect(f).toContain("<th>To</th>");
    expect(f).toContain("<th>Bcc</th>");
    expect(f).toContain("b@x.test");
    expect(f).toContain("<th>Original attachments included</th><td>yes</td>");
    const odd = await createPending(env.DB, {
      userId: "owner-sub",
      accountId: "apa",
      action: "spam.mark",
      modifiers: [],
      payload: { unexpected: "shape<" },
      summary: "s",
    });
    const o = await (await b.get(`/approve/${odd.id}`)).text();
    expect(o).toContain("could not be summarised");
    expect(o).toContain("&quot;unexpected&quot;");
    expect(o).toContain("shape&lt;");
  });

  it("renders the send block with To, Cc and Bcc apart, attachments with sizes, and an escaped untrusted preview capped at 2 KB", async () => {
    const p = await createPending(env.DB, {
      userId: "owner-sub",
      accountId: "apa",
      action: "send.message",
      modifiers: ["+external", "+attachment"],
      payload,
      summary: "To: prof@uni.edu.au",
    });
    const b = await owner();
    const res = await b.get(`/approve/${p.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("send.message");
    expect(html).toContain("personal");
    expect(html).toContain("+external");
    expect(html).toContain("prof@uni.edu.au");
    expect(html.indexOf("<th>To</th>")).toBeLessThan(html.indexOf("prof@uni.edu.au"));
    expect(html.indexOf("<th>Bcc</th>")).toBeLessThan(html.indexOf("hidden@example.test"));
    expect(html).toContain("thesis.pdf");
    expect(html).toContain("2.1 MB");
    expect(html).toContain("Thesis draft \\u{202E}fdp.exe");
    expect(html).toContain("untrusted");
    expect(html).toContain("&lt;a href=&quot;https://evil.test&quot;&gt;");
    expect(html).not.toContain('<a href="https://evil.test"');
    const preview = html.split('class="untrusted"')[1]!.split("</pre>")[0]!;
    expect(new TextEncoder().encode(preview).length).toBeLessThan(2400);
    expect(html).toContain("truncated");
  });

  it("is 404 for another owner's action and for an unknown id", async () => {
    const p = await createPending(env.DB, {
      userId: "other-owner",
      accountId: "apb",
      action: "trash.move",
      modifiers: [],
      payload: { message_id: "m" },
      summary: "s",
    });
    const b = await owner();
    expect((await b.get(`/approve/${p.id}`)).status).toBe(404);
    expect((await b.get(`/approve/pa_${"z".repeat(22)}`)).status).toBe(404);
    expect((await b.get(`/approve/${p.id}`)).headers.get("location")).toBeNull();
  });

  it("approve is the pending->approved transition, guarded by Origin and a CSRF token bound to this id", async () => {
    const a = await createPending(env.DB, {
      userId: "owner-sub",
      accountId: "apa",
      action: "send.message",
      modifiers: [],
      payload,
      summary: "s",
    });
    const bpend = await createPending(env.DB, {
      userId: "owner-sub",
      accountId: "apa",
      action: "send.message",
      modifiers: [],
      payload,
      summary: "s",
    });
    const b = await owner();
    const csrfA = csrfFrom(await (await b.get(`/approve/${a.id}`)).text(), `/approve/${a.id}`);
    expect((await b.post(`/approve/${bpend.id}`, { decision: "approve", csrf: csrfA })).status).toBe(403);
    expect(
      (await b.post(`/approve/${a.id}`, { decision: "approve", csrf: csrfA }, { origin: "https://evil.test" })).status,
    ).toBe(403);
    expect(
      (
        await b.fetch(`/approve/${a.id}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: "" },
          body: `decision=approve&csrf=${csrfA}`,
        })
      ).status,
    ).toBe(403);
    const ok = await b.post(`/approve/${a.id}`, { decision: "approve", csrf: csrfA });
    expect(ok.status).toBe(303);
    const row = await env.DB.prepare("SELECT state, approved_via, payload_json FROM pending_actions WHERE id = ?")
      .bind(a.id)
      .first<any>();
    expect(row.state).toBe("approved");
    expect(row.approved_via).toBe("browser");
    expect(row.payload_json).not.toBeNull();
    const again = await b.post(`/approve/${a.id}`, { decision: "approve", csrf: csrfA });
    expect(again.status).toBe(409);
    expect(await (await b.get(`/approve/${a.id}`)).text()).toContain("approved");
    const audit = await env.DB.prepare(
      "SELECT decision, phase, summary FROM audit_log WHERE pending_id = ? ORDER BY id DESC LIMIT 1",
    )
      .bind(a.id)
      .first<any>();
    expect(audit).toEqual({ decision: "approved", phase: "outcome", summary: "recipients=3 attachments=1" });
    // The transition and the audit row are one batch: a second approve writes neither.
    const auditCount = await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE pending_id = ?")
      .bind(a.id)
      .first<{ n: number }>();
    await b.post(`/approve/${a.id}`, { decision: "approve", csrf: csrfA });
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE pending_id = ?")
        .bind(a.id)
        .first<{ n: number }>(),
    ).toEqual(auditCount);
  });

  it("deny purges the payload; an expired action cannot be approved", async () => {
    const d = await createPending(env.DB, {
      userId: "owner-sub",
      accountId: "apa",
      action: "send.message",
      modifiers: [],
      payload,
      summary: "s",
    });
    const b = await owner();
    const csrf = csrfFrom(await (await b.get(`/approve/${d.id}`)).text(), `/approve/${d.id}`);
    expect((await b.post(`/approve/${d.id}`, { decision: "deny", csrf })).status).toBe(303);
    const row = await env.DB.prepare("SELECT state, payload_json, summary FROM pending_actions WHERE id = ?")
      .bind(d.id)
      .first<any>();
    expect(row).toEqual({ state: "denied", payload_json: null, summary: "redacted" });

    const x = await createPending(env.DB, {
      userId: "owner-sub",
      accountId: "apa",
      action: "send.message",
      modifiers: [],
      payload,
      summary: "s",
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 5));
    const page = await b.get(`/approve/${x.id}`);
    expect(await page.text()).toContain("expired");
    expect(page.status).toBe(200);
  });
});
