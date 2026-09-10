import { describe, it, expect } from "vitest";
import { FakeGmail } from "./fake-gmail";
import { messageView, findAttachment, partData, splitAddressList, gmailFormatFor } from "../src/google/messages";

const gm = new FakeGmail();
const bytes = new TextEncoder();

describe("messageView", () => {
  const m = gm.seedMessage({
    from: "Ann <ann@example.test>",
    to: ["Bob <bob@example.test>", "carol@example.test"],
    cc: ["dave@example.test"],
    replyTo: '"Doe, Jane" <jane@example.test>, ann@example.test',
    subject: "Hello 🚀",
    text: "plain body ".repeat(50),
    html: "<p>html body</p>",
    attachments: [
      { filename: "notes.pdf", mime: "application/pdf", bytes: new Uint8Array(bytes.encode("%PDF")) },
      { filename: "tiny.txt", mime: "text/plain", bytes: new Uint8Array(bytes.encode("tiny")), inline: true },
    ],
  });

  it("PLAIN_TEXT carries headers, text body and attachment metadata for external and inline parts, never bytes", () => {
    const v = messageView(m, { format: "PLAIN_TEXT", bodyCharLimit: 10_000, includeBody: true });
    expect(v).toMatchObject({
      id: m.id,
      thread_id: m.threadId,
      subject: "Hello 🚀",
      from: "Ann <ann@example.test>",
      to: ["Bob <bob@example.test>", "carol@example.test"],
      cc: ["dave@example.test"],
      bcc: [],
      reply_to: ['"Doe, Jane" <jane@example.test>', "ann@example.test"],
      message_id_header: `<${m.id}@fake.test>`,
    });
    expect(v.plaintext_body).toMatch(/^plain body /);
    expect(v.html_body).toBeUndefined();
    expect(v.attachments).toEqual([
      { part_id: "2", attachment_id: `att${m.id}_0`, filename: "notes.pdf", mime: "application/pdf", size: 4 },
      { part_id: "3", attachment_id: null, filename: "tiny.txt", mime: "text/plain", size: 4 },
    ]);
    expect(JSON.stringify(v)).not.toContain("JVBERi");
    expect(JSON.stringify(v)).not.toContain("dGlueQ");
  });
  it("FULL_CONTENT adds the html body; METADATA_ONLY and MINIMAL carry no body", () => {
    expect(messageView(m, { format: "FULL_CONTENT", bodyCharLimit: 10_000, includeBody: true }).html_body).toBe(
      "<p>html body</p>",
    );
    const meta = messageView(m, { format: "METADATA_ONLY", bodyCharLimit: 10_000, includeBody: true });
    expect(meta.plaintext_body).toBeUndefined();
    expect(meta.subject).toBe("Hello 🚀");
    const min = messageView({ ...m, payload: undefined }, { format: "MINIMAL", bodyCharLimit: 10, includeBody: true });
    expect(min.subject).toBeNull();
    expect(min.attachments).toEqual([]);
  });
  it("truncates the body at body_char_limit on a code point boundary and says so", () => {
    const v = messageView(m, { format: "PLAIN_TEXT", bodyCharLimit: 25, includeBody: true });
    expect(v.plaintext_body).toHaveLength(25);
    expect(v.body_truncated).toBe(true);
    const emoji = gm.seedMessage({ from: "a@x.test", to: ["b@x.test"], subject: "s", text: "😀😀😀" });
    expect(messageView(emoji, { format: "PLAIN_TEXT", bodyCharLimit: 1, includeBody: true }).plaintext_body).toBe("😀");
    expect(
      messageView(m, { format: "PLAIN_TEXT", bodyCharLimit: 25, includeBody: false }).plaintext_body,
    ).toBeUndefined();
  });
  it("finds an attachment by attachment id or part id, and reads inline part data", () => {
    expect(findAttachment(m, { attachmentId: `att${m.id}_0` })).toMatchObject({ filename: "notes.pdf", size: 4 });
    expect(findAttachment(m, { partId: "3" })).toMatchObject({ filename: "tiny.txt", attachment_id: null });
    expect(findAttachment(m, { attachmentId: "nope" })).toBeNull();
    expect(partData(m, "3")).toBe("dGlueQ");
    expect(partData(m, "2")).toBeNull();
  });
  it("splits address lists like RFC 5322: quotes with escapes, comments, brackets, groups", () => {
    expect(splitAddressList('"Doe, Jane" <jane@x.test>, bob@x.test , <c@x.test>')).toEqual([
      '"Doe, Jane" <jane@x.test>',
      "bob@x.test",
      "<c@x.test>",
    ]);
    expect(splitAddressList('"Say \\"hi\\", now" <q@x.test>, d@x.test')).toEqual([
      '"Say \\"hi\\", now" <q@x.test>',
      "d@x.test",
    ]);
    expect(splitAddressList("a@x.test (comma, inside (nested)), b@x.test")).toEqual([
      "a@x.test (comma, inside (nested))",
      "b@x.test",
    ]);
    expect(splitAddressList("Team: t1@x.test, t2@x.test; solo@x.test")).toEqual([
      "t1@x.test",
      "t2@x.test",
      "solo@x.test",
    ]);
    expect(splitAddressList("Empty:; solo@x.test")).toEqual(["solo@x.test"]);
    expect(splitAddressList("")).toEqual([]);
  });
  it("maps formats to Gmail's wire values", () => {
    expect(gmailFormatFor("PLAIN_TEXT")).toEqual({ format: "full" });
    expect(gmailFormatFor("METADATA_ONLY")).toEqual({
      format: "metadata",
      metadataHeaders: [
        "Subject",
        "From",
        "To",
        "Cc",
        "Bcc",
        "Reply-To",
        "Date",
        "Message-ID",
        "In-Reply-To",
        "References",
      ],
    });
    expect(gmailFormatFor("RAW")).toEqual({ format: "raw" });
    expect(gmailFormatFor("MINIMAL")).toEqual({ format: "minimal" });
  });
});
