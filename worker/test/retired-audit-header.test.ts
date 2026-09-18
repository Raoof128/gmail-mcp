import { describe, it, expect } from "vitest";
import { buildMime } from "../src/mime/build";

/**
 * P6-AUDIT-HEADER in the deferred feature register is retired rather than deferred: the original design
 * refused to put an internal correlation identifier into mail leaving for recipients' servers. A retired
 * privacy decision with no test is exactly the kind of item that comes back quietly, so this pins it.
 *
 * The check is deliberately broad. It fails on any X- header at all, not only the one that was named,
 * because the decision was about internal metadata reaching recipients rather than about one spelling.
 */
const HEADER_LINE = /^[A-Za-z0-9-]+:/;

describe("no internal correlation metadata leaves in outgoing mail", () => {
  it("emits no X- header of any kind, with or without attachments", async () => {
    for (const attachments of [
      [],
      [{ filename: "a.txt", mime: "text/plain", size: 3, open: () => Promise.resolve(new Response("abc").body!) }],
    ]) {
      const bytes = await buildMime({
        from: "owner@example.test",
        to: ["recipient@example.test"],
        cc: [],
        bcc: [],
        subject: "retired header check",
        messageId: "<op-1@worker.example.test>",
        text: "body",
        attachments,
      });
      const text = new TextDecoder().decode(bytes);
      const headers = text
        .split("\r\n\r\n")[0]!
        .split("\r\n")
        .filter((line) => HEADER_LINE.test(line))
        .map((line) => line.slice(0, line.indexOf(":")).toLowerCase());

      expect(headers.filter((h) => h.startsWith("x-"))).toEqual([]);
      expect(text.toLowerCase()).not.toContain("x-claude-audit-id");
      // The headers that should be there still are, so this is not passing on an empty document.
      expect(headers).toContain("message-id");
      expect(headers).toContain("subject");
    }
  });

  it("carries no operation or account identifier anywhere in the message", async () => {
    const operationId = "op_deadbeefdeadbeefdeadbeef";
    const bytes = await buildMime({
      from: "owner@example.test",
      to: ["recipient@example.test"],
      cc: [],
      bcc: [],
      subject: "retired header check",
      // The generated Message-ID is the one identifier that legitimately travels, and it is the
      // operation id by design, so the message id is excluded from this check rather than the id.
      messageId: `<${operationId}@worker.example.test>`,
      text: "body",
      attachments: [],
    });
    const text = new TextDecoder().decode(bytes);
    const withoutMessageId = text.replace(new RegExp(`<${operationId}@[^>]+>`, "g"), "");
    expect(withoutMessageId).not.toContain(operationId);
    expect(withoutMessageId).not.toContain("account");
  });
});
