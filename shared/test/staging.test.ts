import { describe, expect, it } from "vitest";
import { TransferIntent, TransferId, STAGING_LIMITS } from "../src/staging";
const id = `tr_${"a".repeat(43)}`;
const metadata = { filename: "report.pdf", size: 0, mime: "application/pdf", sha256: "0".repeat(64) };
describe("staging contracts", () => {
  it("accepts empty regular-file metadata and strict ensure intent", () => {
    expect(TransferIntent.parse({ mode: "ensure", transfer_id: id, account: "work", metadata }).metadata.size).toBe(0);
    expect(STAGING_LIMITS.fileBytes).toBe(25 * 1024 * 1024);
  });
  it("rejects paths, noncanonical unicode, invalid MIME and oversized bytes before intent", () => {
    for (const extra of [
      { filename: "../secret" },
      { filename: "a\\b" },
      { filename: "e\u0301.pdf" },
      { mime: "text/plain\r\nx:y" },
      { size: STAGING_LIMITS.fileBytes + 1 },
    ]) {
      expect(
        TransferIntent.safeParse({
          mode: "ensure",
          transfer_id: id,
          account: "work",
          metadata: { ...metadata, ...extra },
        }).success,
      ).toBe(false);
    }
  });
  it("requires a stable retry identity and expected generation", () => {
    const base = { mode: "retry", transfer_id: id, account: "work", metadata };
    expect(TransferIntent.safeParse(base).success).toBe(false);
    expect(
      TransferIntent.safeParse({ ...base, expected_generation: 1, retry_request_id: `rr_${"b".repeat(43)}` }).success,
    ).toBe(true);
    expect(TransferIntent.safeParse({ ...base, expected_generation: 0, retry_request_id: "bad" }).success).toBe(false);
  });
  it("rejects unknown fields and arbitrary identifiers", () => {
    expect(TransferId.safeParse("tr_guess").success).toBe(false);
    expect(
      TransferIntent.safeParse({ mode: "ensure", transfer_id: id, account: "work", metadata, user_id: "attacker" })
        .success,
    ).toBe(false);
  });
});
