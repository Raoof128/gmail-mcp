// Review-only counterexamples. These do not execute the Worker or contact Gmail.
import assert from "node:assert/strict";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { stdout } from "node:process";
const report = (message) => stdout.write(message + "\n");
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const raw =
  "https://gmail.googleapis.com/upload/gmail/v1/users/me/extra/%2e%2e/messages/send?uploadType=resumable&upload_id=fixture";
assert(raw.includes("%2e%2e"));
assert.equal(new URL(raw).pathname, "/upload/gmail/v1/users/me/messages/send");
report("CONFIRMED: parsed pathname loses encoded dot-segment evidence");

const startedAt = 1000000;
const oldSent = {
  threadId: "same-thread",
  labels: ["SENT"],
  messageIds: ["<reused@example.test>"],
  internalDate: startedAt - 60000,
};
const allowedByWrittenRules =
  oldSent.labels.includes("SENT") &&
  oldSent.messageIds.length === 1 &&
  oldSent.messageIds[0] === "<reused@example.test>" &&
  oldSent.threadId === "same-thread" &&
  oldSent.internalDate >= startedAt - 120000 &&
  oldSent.internalDate <= startedAt + 86400000;
assert(allowedByWrittenRules);
report("CONFIRMED: earlier sent copy satisfies written predicates without proving current draft delivery");

assert(2 * 30 > 30);
report("CONFIRMED: two independent thirty-request counters permit sixty requests");
assert(3600 > 1800);
report("CONFIRMED: a one-hour Retry-After exceeds an absolute thirty-minute retry cap");

// Reconstruct revision 1 from its immutable line ledger; current drafts are revision 2.
function csvFields(line) {
  const fields = [];
  let value = "",
    quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      fields.push(value);
      value = "";
    } else value += char;
  }
  fields.push(value);
  return fields;
}
const rows = readFileSync(new URL("./2026-09-13-plan-5-line-review.csv", import.meta.url), "utf8")
  .trimEnd()
  .split(/\r?\n/)
  .slice(1)
  .map(csvFields);
for (const [relative, lines, hash] of [
  [
    "specs/2026-09-13-gmail-mcp-plan-5-recovery-design.md",
    100,
    "6b258912853b5ee2983d5ee4e3bf715fbe39c014a666f178096e25651914efa9",
  ],
  [
    "plans/2026-09-13-gmail-mcp-plan-5-recovery-and-release.md",
    225,
    "70b16b5a5bf55b0047b3aeaa305ab5f1c2332f0fff2c6017c85a22aec9b3e398",
  ],
]) {
  const original =
    rows
      .filter((row) => row[0] === relative)
      .map((row) => row[5])
      .join("\n") + "\n";
  const body = Buffer.from(original);
  assert.equal(createHash("sha256").update(body).digest("hex"), hash, "historical review ledger changed");
  assert.equal(body.toString().trimEnd().split("\n").length, lines);
  report(`HISTORICAL INPUT VERIFIED: ${relative}, ${lines} lines, ${hash}`);
}
