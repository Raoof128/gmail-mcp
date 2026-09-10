import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { FakeGoogle } from "./fake-google";
import { FakeGmail } from "./fake-gmail";
import { seedUserAndAccount, seedAccessToken } from "./fixtures";
import { testDeps, testEnv } from "./test-env";
import { gmailFetch, gmailJson } from "../src/google/gmail";
import type { Deps } from "../src/deps";

let g: FakeGoogle;
let gm: FakeGmail;
let deps: Deps;
const acct = { userId: "gu", accountId: "ga" };
const e = testEnv();

beforeAll(async () => {
  g = await FakeGoogle.create();
  gm = g.gmail;
  deps = testDeps(g);
  await seedUserAndAccount(env.DB, { userId: "gu", accountId: "ga", alias: "main", isDefault: true });
  g.refreshTokens.set("rt-g", "ok");
  await seedAccessToken(e, { userId: "gu", accountId: "ga", access: "at-good", refresh: "rt-g" });
});

describe("gmailFetch", () => {
  it("sends the bearer, builds the users/me URL and the query", async () => {
    gm.labels.set("Label_9", { id: "Label_9", name: "nine", type: "user" });
    const body = await gmailJson<{ labels: { id: string }[] }>(e, deps, acct, {
      method: "GET",
      path: "labels",
      retry: "safe",
    });
    expect(body.labels.map((l) => l.id)).toContain("Label_9");
    const last = gm.requests.at(-1)!;
    expect(last.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/labels");
    expect(last.headers.get("authorization")).toBe("Bearer at-good");
    await gmailFetch(e, deps, acct, {
      method: "GET",
      path: "threads",
      query: { q: "from:a b", maxResults: 20, pageToken: undefined, includeSpamTrash: false },
      retry: "safe",
    });
    expect(gm.requests.at(-1)!.url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/threads?q=from%3Aa+b&maxResults=20&includeSpamTrash=false",
    );
  });

  it("on 401 refreshes once and retries once, then gives up", async () => {
    await seedAccessToken(e, { userId: "gu", accountId: "ga", access: "at-stale", refresh: "rt-g" });
    gm.rejectTokens.add("at-stale");
    const calls = g.tokenCalls;
    const res = await gmailFetch(e, deps, acct, { method: "GET", path: "labels", retry: "safe" });
    expect(res.status).toBe(200);
    expect(g.tokenCalls).toBe(calls + 1);
    expect(gm.requests.at(-1)!.headers.get("authorization")).toMatch(/^Bearer at-\d+$/);
    // Every token is rejected: one refresh, one retry, then the 401 surfaces as an error.
    gm.rejectAll = true;
    const before = gm.requests.length;
    await expect(gmailFetch(e, deps, acct, { method: "GET", path: "labels", retry: "safe" })).rejects.toMatchObject({
      code: "gmail_error",
      status: 401,
    });
    expect(gm.requests.length - before).toBe(2);
    gm.rejectAll = false;
  });

  it("backs off on 429 honouring Retry-After, at most three tries, only for retry: safe", async () => {
    const slept: number[] = [];
    const d: Deps = {
      ...testDeps(g),
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    };
    gm.faults.push({ status: 429, headers: { "retry-after": "2" } }, { status: 503 });
    const res = await gmailFetch(e, d, acct, { method: "GET", path: "labels", retry: "safe" });
    expect(res.status).toBe(200);
    expect(slept[0]).toBe(2000);
    expect(slept[1]).toBeGreaterThanOrEqual(500);
    expect(slept[1]).toBeLessThanOrEqual(1500);
    gm.faults.push({ status: 503 }, { status: 503 }, { status: 503 });
    await expect(gmailFetch(e, d, acct, { method: "GET", path: "labels", retry: "safe" })).rejects.toMatchObject({
      status: 503,
    });
    gm.faults.length = 0;
    // A send is never retried after it was opened.
    gm.faults.push({ status: 503 });
    const before = gm.requests.length;
    await expect(
      gmailFetch(e, d, acct, {
        method: "POST",
        path: "messages/send",
        upload: { kind: "media", contentType: "message/rfc822", bytes: new TextEncoder().encode("x") },
        retry: "none",
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(gm.requests.length - before).toBe(1);
  });

  it("surfaces Google's error message verbatim and classifies rate-limit 403s", async () => {
    gm.faults.push({ status: 400, message: "Invalid attachment: nope.exe" });
    await expect(gmailFetch(e, deps, acct, { method: "GET", path: "labels", retry: "safe" })).rejects.toMatchObject({
      googleMessage: "Invalid attachment: nope.exe",
    });
    gm.faults.push(
      { status: 403, reason: "userRateLimitExceeded" },
      { status: 403, reason: "insufficientPermissions" },
    );
    await expect(gmailFetch(e, deps, acct, { method: "GET", path: "labels", retry: "safe" })).rejects.toMatchObject({
      status: 403,
      reason: "insufficientPermissions",
    });
  });

  it("media upload posts message/rfc822 to the upload host; resumable does POST then PUT", async () => {
    const bytes = new TextEncoder().encode("From: a@b.test\r\n\r\nhi");
    const r1 = await gmailJson<{ id: string }>(e, deps, acct, {
      method: "POST",
      path: "messages/send",
      upload: { kind: "media", contentType: "message/rfc822", bytes },
      retry: "none",
    });
    expect(r1.id).toMatch(/^m/);
    expect(gm.requests.at(-1)!.url).toBe(
      "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media",
    );
    expect(gm.sent.at(-1)!.via).toBe("media");
    const r2 = await gmailJson<{ id: string }>(e, deps, acct, {
      method: "POST",
      path: "messages/send",
      upload: { kind: "resumable", contentType: "message/rfc822", bytes },
      retry: "none",
    });
    expect(r2.id).toMatch(/^m/);
    const [start, put] = gm.requests.slice(-2);
    expect(start!.url).toBe(
      "https://gmail.googleapis.com/resumable/upload/gmail/v1/users/me/messages/send?uploadType=resumable",
    );
    expect(start!.headers.get("x-upload-content-type")).toBe("message/rfc822");
    expect(start!.headers.get("x-upload-content-length")).toBe(String(bytes.byteLength));
    expect(put!.method).toBe("PUT");
    expect(put!.url).toContain("upload_id=");
    expect(gm.sent.at(-1)!.via).toBe("resumable");
  });

  it("needs_reconnect accounts never reach Gmail", async () => {
    await env.DB.prepare("UPDATE accounts SET status = 'needs_reconnect' WHERE id = 'ga'").run();
    const before = gm.requests.length;
    await expect(gmailFetch(e, deps, acct, { method: "GET", path: "labels", retry: "safe" })).rejects.toMatchObject({
      code: "account_needs_reconnect",
    });
    expect(gm.requests.length).toBe(before);
    await env.DB.prepare("UPDATE accounts SET status = 'active' WHERE id = 'ga'").run();
  });
});
