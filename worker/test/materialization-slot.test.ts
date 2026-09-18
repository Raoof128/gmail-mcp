import { env } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import { seedUserAndAccount } from "./fixtures";
import { setPolicy } from "../src/policy/engine";
import { ensureTransfer } from "../src/staging/transfers";
import { sha256Hex } from "../src/crypto/canonical";
import { withMaterialization } from "../src/staging/materialization";
import { recoverUploads } from "../src/staging/recovery";
import { STAGING_LIMITS as L } from "@gmail-mcp/shared/staging";

const USER = "mat-owner";
const ACCOUNT = "mat-account";

beforeAll(async () => {
  await seedUserAndAccount(env.DB, { userId: USER, accountId: ACCOUNT, alias: "work" });
  await setPolicy(env.DB, { userId: USER, accountId: ACCOUNT, action: "attachment.stage_upload", level: "allow" });
});

const slots = async () =>
  (await env.DB.prepare("SELECT count(*) n FROM staging_materializations").first<{ n: number }>())?.n ?? 0;
const liveSlots = async (now = Date.now()) =>
  (
    await env.DB.prepare("SELECT count(*) n FROM staging_materializations WHERE lease_until>?")
      .bind(now)
      .first<{ n: number }>()
  )?.n ?? 0;

/** Holds the slot until the returned release is called, so a second claimant can be tried against it. */
function held() {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return { gate, release };
}

describe("the global materialization slot", () => {
  it("admits one holder and refuses a second while it is live", async () => {
    const { gate, release } = held();
    let insideCount = 0;
    const first = withMaterialization(env, async () => {
      insideCount++;
      expect(await liveSlots()).toBe(1);
      await gate;
      return "first";
    });
    // Let the first claim land before the second tries.
    await new Promise((r) => setTimeout(r, 0));
    await expect(withMaterialization(env, () => Promise.resolve("second"))).rejects.toThrow(/limit_exceeded/);
    release();
    expect(await first).toBe("first");
    expect(insideCount).toBe(1);
    expect(await slots()).toBe(0);
  });

  it("returns the slot when the holder throws, so the next claimant is admitted", async () => {
    await expect(
      withMaterialization(env, () => Promise.reject(new Error("job blew up inside the slot"))),
    ).rejects.toThrow("job blew up inside the slot");
    // The finally released it even though the body failed.
    expect(await slots()).toBe(0);
    expect(await withMaterialization(env, () => Promise.resolve("after failure"))).toBe("after failure");
    expect(await slots()).toBe(0);
  });

  it("refuses the same owner a second concurrent job", async () => {
    const { gate, release } = held();
    const reservation = { userId: USER, accountId: ACCOUNT, bytes: 1 };
    const first = withMaterialization(
      env,
      async () => {
        await gate;
        return "first";
      },
      reservation,
    );
    await new Promise((r) => setTimeout(r, 0));
    await expect(withMaterialization(env, () => Promise.resolve("second"), reservation)).rejects.toThrow(
      /limit_exceeded/,
    );
    release();
    await first;
    expect(await slots()).toBe(0);
  });

  /**
   * The liveness half, and the honest cost of it. The admission predicate is lease_until > now, so a
   * holder that stalls past its lease stops excluding anyone. That buys recovery from a process that
   * died without running its finally, and it is the reason exclusivity is time-bounded rather than
   * absolute. A stalled holder that later returns does not get the slot back.
   */
  it("stops excluding once the holder's lease has expired, and the cron reclaims the row", async () => {
    const { gate, release } = held();
    const stalled = withMaterialization(env, async () => {
      await gate;
      return "stalled";
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(await slots()).toBe(1);

    // Age the lease the way a stalled process would.
    await env.DB.prepare("UPDATE staging_materializations SET lease_until=? WHERE lease_until>?")
      .bind(Date.now() - 1, Date.now() - L.leaseMs)
      .run();
    expect(await liveSlots()).toBe(0);

    // A new claimant is admitted, which is liveness bought at the price of exclusivity beyond the lease.
    expect(await withMaterialization(env, () => Promise.resolve("took over"))).toBe("took over");

    // The cron removes the abandoned row rather than leaving it to accumulate, so a stalled holder
    // costs one expired row until the next sweep and nothing after it.
    await recoverUploads(env, Date.now());
    expect(await slots()).toBe(0);
    release();
    await stalled;
    expect(await slots()).toBe(0);
  });

  it("is blocked by a live upload and admitted again once that upload settles", async () => {
    // Created through the real intent path: inventing an upload_generations row breaks its foreign key
    // to the transfer that owns it.
    const bytes = new TextEncoder().encode("blocking upload");
    const issued = await ensureTransfer(
      env,
      { userId: USER, email: "t@example.test", scope: "staging" },
      {
        mode: "ensure",
        transfer_id: `tr_${"M".repeat(43)}`,
        account: "work",
        metadata: {
          filename: "b.txt",
          mime: "text/plain",
          size: bytes.length,
          sha256: await sha256Hex(new Uint8Array(bytes)),
        },
      },
    );
    await env.DB.prepare("UPDATE upload_generations SET state='uploading',lease_until=? WHERE ticket_id=?")
      .bind(Date.now() + 60_000, issued.ticket_id)
      .run();
    await expect(withMaterialization(env, () => Promise.resolve("blocked"))).rejects.toThrow(/limit_exceeded/);

    await env.DB.prepare("UPDATE upload_generations SET state='completed' WHERE ticket_id=?")
      .bind(issued.ticket_id)
      .run();
    expect(await withMaterialization(env, () => Promise.resolve("admitted"))).toBe("admitted");
    expect(await slots()).toBe(0);
  });

  it("never leaves a slot behind when the reservation itself is refused", async () => {
    const before = await slots();
    await expect(
      withMaterialization(env, () => Promise.resolve("never runs"), {
        userId: USER,
        accountId: "no-such-account",
        bytes: 1,
      }),
    ).rejects.toThrow(/limit_exceeded/);
    expect(await slots()).toBe(before);
  });
});
