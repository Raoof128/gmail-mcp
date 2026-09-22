import { expect, it, vi } from "vitest";
import { parseSessionStatus, validateSessionUrl } from "../src/google/resumable";
const base = "https://gmail.googleapis.com/upload/gmail/v1/users/me/";
it("binds exact send and draft endpoints without normalizing traversal", () => {
  expect(validateSessionUrl(base + "messages/send?uploadType=resumable&upload_id=abc", { kind: "send" }).hostname).toBe(
    "gmail.googleapis.com",
  );
  expect(
    validateSessionUrl(base + "drafts/d1?uploadType=resumable&upload_id=abc", { kind: "draft_update", draftId: "d1" })
      .pathname,
  ).toContain("drafts/d1");
  for (const raw of [
    base + "x/%2e%2e/messages/send?uploadType=resumable&upload_id=abc",
    base + "messages/send?uploadType=resumable&upload_id=a&x=1",
    base + "drafts?uploadType=resumable&upload_id=abc",
    base + "messages/send?uploadType=resumable&upload_id=a#fragment",
    "https://evil.test/upload/gmail/v1/users/me/messages/send?uploadType=resumable&upload_id=a",
  ]) {
    expect(() => validateSessionUrl(raw, { kind: "send" })).toThrow();
  }
});
it.each(["bytes=0-42", "0-42"])("accepts 308 range %s without requiring Location", (range) => {
  expect(parseSessionStatus(308, range, 100, 0, new Uint8Array(), "send-v1")).toEqual({
    kind: "incomplete",
    nextOffset: 43,
  });
});
it("refuses overflow/regression and does not infer completion from offset", () => {
  expect(parseSessionStatus(308, "0-99", 100, 0, new Uint8Array(), "send-v1")).toEqual({ kind: "awaiting_final" });
  for (const range of [null, "0-10", "0-9007199254740992", "0-100"])
    expect(parseSessionStatus(308, range, 100, 43, new Uint8Array(), "send-v1")).toEqual({
      kind: "unknown",
      reason: "invalid_response",
    });
});
it.each([404, 410])("expired session %s remains unknown", (status) => {
  expect(parseSessionStatus(status, null, 100, 43, new Uint8Array(), "send-v1")).toEqual({
    kind: "unknown",
    reason: "expired",
  });
});
it("accepts only bounded final message schema", () => {
  const body = new TextEncoder().encode(JSON.stringify({ id: "m1", threadId: "t1", labelIds: ["SENT"] }));
  expect(parseSessionStatus(200, null, 100, 43, body, "send-v1")).toEqual({
    kind: "complete",
    result: { gmail_result_id: "m1", message: { id: "m1", thread_id: "t1", label_ids: ["SENT"] } },
  });
  expect(parseSessionStatus(201, null, 100, 43, new Uint8Array(65537), "send-v1").kind).toBe("unknown");
});

it("rejects an original foreign session before looking up a credential", async () => {
  const { putResumable } = await import("../src/google/gmail");
  const { testEnv } = await import("./test-env");
  const { defaultDeps } = await import("../src/deps");
  await expect(
    putResumable(testEnv(), defaultDeps, { userId: "missing", accountId: "missing" }, "https://evil.test/session", {
      endpoint: { kind: "send" },
      contentType: "message/rfc822",
      length: 0,
      body: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
    }),
  ).rejects.toThrow("invalid resumable session endpoint");
});

it("describes a refused session URL by shape without leaking the upload id", async () => {
  const { describeSessionUrl } = await import("../src/google/resumable");
  const secret = "ADPycdSECRETcapability_value-123";
  const raw = `https://gmail.googleapis.com/upload/gmail/v1/users/someone%40example.com/drafts?uploadType=resumable&upload_protocol=resumable&upload_id=${secret}`;
  const shape = describeSessionUrl(raw);
  const text = JSON.stringify(shape);
  expect(text).not.toContain(secret);
  expect(text).not.toContain("someone");
  expect(shape.host).toBe("gmail.googleapis.com");
  expect(shape.path).toEqual(["upload", "gmail", "v1", "users", "<seg:21:%.>", "drafts"]);
  expect(shape.query).toEqual([
    { name: "uploadType", value: "resumable" },
    { name: "upload_protocol", value: "resumable" },
    { name: "upload_id", value: `<len:${secret.length}:-_>` },
  ]);
});

it("logs the refusal reason and shape, never the capability", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const secret = "SECRETuploadid";
  expect(() =>
    validateSessionUrl(`${base}drafts?uploadType=resumable&upload_id=${secret}&extra=1`, { kind: "draft_create" }),
  ).toThrow("invalid resumable session endpoint");
  expect(warn).toHaveBeenCalledTimes(1);
  const logged = String(warn.mock.calls[0]![0]);
  expect(logged).toContain('"event":"resumable_session_refused"');
  expect(logged).toContain('"reason":"query"');
  expect(logged).not.toContain(secret);
  warn.mockRestore();
});

it("accepts the session_crd parameter Google's live session URLs carry", () => {
  const live = "https://gmail.googleapis.com/resumable/upload/gmail/v1/users/me/drafts";
  const id = "A".repeat(55) + "-_" + "b".repeat(53);
  const crd = "C".repeat(500) + "_-" + "d".repeat(10);
  expect(
    validateSessionUrl(`${live}?uploadType=resumable&upload_id=${id}&session_crd=${crd}`, { kind: "draft_create" })
      .pathname,
  ).toBe("/resumable/upload/gmail/v1/users/me/drafts");
  for (const bad of [
    `${live}?uploadType=resumable&upload_id=${id}&session_crd=${crd}&x=1`,
    `${live}?uploadType=resumable&upload_id=${id}&session_crd=${crd}&session_crd=${crd}`,
    `${live}?uploadType=resumable&upload_id=${id}&session_crd=a.b`,
    `${live}?uploadType=resumable&upload_id=${id}&session_crd=`,
    `${live}?uploadType=resumable&session_crd=${crd}`,
  ])
    expect(() => validateSessionUrl(bad, { kind: "draft_create" })).toThrow("invalid resumable session endpoint");
});
