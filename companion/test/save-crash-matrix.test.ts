import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { Companion } from "../src/transfers.ts";
import { Authority } from "../src/http.ts";
import type { NativePort } from "../src/native.ts";

const PAYLOAD = new TextEncoder().encode("companion crash matrix payload");
const DIGEST = createHash("sha256").update(PAYLOAD).digest("hex");
const HANDLE = "sh_" + "a".repeat(43);
const INPUT = { handle: HANDLE, root: "attachments", path: "a.txt" };

/**
 * A stand-in for the native helper that keeps the state the helper keeps durably: whether a temporary
 * file exists, whether a published file exists, and the receipt. Crashes are injected by name so a
 * single case can die at one edge and the next call resumes from whatever really survived, which is the
 * only way to tell a durable receipt apart from an in-memory one.
 */
type Crash = "prepare-before" | "prepare-after" | "publish-before" | "publish-after" | "ack-native-after-http" | null;

class FakeNative implements NativePort {
  receipt: "prepared" | "published" | "acknowledged" = "prepared";
  temp = false;
  published: { sha256: string; bytes: Uint8Array } | null = null;
  // attempts is what the port was asked to do; durable is what actually survived a crash. The
  // invariant is about the second number, and conflating them is how a retry looks like a duplicate.
  counts = { prepare: 0, publishAttempts: 0, durablePublications: 0, ack: 0 };
  crash: Crash = null;
  /** Makes the helper report success while leaving the receipt short of it. */
  silentAck = false;
  prepareState: "prepared" | "published" | "acknowledged" | "failed" | null = null;

  close() {}
  call(command: Record<string, unknown>, body?: Uint8Array) {
    const op = command.op as string;
    if (op === "save.prepare") {
      this.counts.prepare++;
      if (this.crash === "prepare-before") throw new Error("crash before the temporary file existed");
      // Preparing creates the temporary file only when there is nothing published yet.
      if (this.receipt === "prepared") this.temp = true;
      if (this.crash === "prepare-after") throw new Error("crash after the temporary file existed");
    }
    if (op === "save.publish") {
      this.counts.publishAttempts++;
      if (this.crash === "publish-before") throw new Error("crash before the bytes were made durable");
      // The helper writes, fsyncs, renames and records the receipt as one durable step.
      this.counts.durablePublications++;
      this.published = { sha256: command.sha256 as string, bytes: body ?? new Uint8Array() };
      this.temp = false;
      this.receipt = "published";
      if (this.crash === "publish-after") throw new Error("crash after fsync, before the reply was read");
    }
    if (op === "save.ack") {
      this.counts.ack++;
      if (this.crash === "ack-native-after-http") throw new Error("crash after the remote ack, before the receipt");
      if (!this.silentAck) this.receipt = "acknowledged";
    }
    return Promise.resolve({
      meta: {
        state: op === "save.prepare" && this.prepareState ? this.prepareState : this.receipt,
        root: "attachments",
        relative: "a.txt",
        file: { size: PAYLOAD.length, sha256: DIGEST },
      },
      body: new Uint8Array(),
    });
  }
}

type Remote = { gets: number; acks: number; failGet?: number; failAck?: boolean; digest?: string; bytes?: Uint8Array };

function authority(remote: Remote) {
  return new Authority("https://worker.example.test", (url) => {
    const path = (url as URL).pathname;
    if (path.endsWith("/ack")) {
      remote.acks++;
      if (remote.failAck) return Promise.reject(new Error("ack transport lost"));
      return Promise.resolve(Response.json({ acknowledged: true, replayed: remote.acks > 1 }));
    }
    remote.gets++;
    if (remote.failGet) return Promise.resolve(new Response("gone", { status: remote.failGet }));
    const bytes = remote.bytes ?? PAYLOAD;
    // Typed arrays are generic since TypeScript 5.7, so an ArrayBufferLike-backed view does not satisfy
    // BodyInit. Copy into an ArrayBuffer-backed one at the boundary, as the worker does.
    const body = new Uint8Array(new ArrayBuffer(bytes.length));
    body.set(bytes);
    return Promise.resolve(
      new Response(body, {
        headers: { "content-length": String(bytes.length), "x-sha256": remote.digest ?? DIGEST },
      }),
    );
  });
}
const service = (native: NativePort, remote: Remote) =>
  new Companion(native, authority(remote), "test-only", { user_id: "owner", client_id: "client" });

function evidence(native: FakeNative, remote: Remote) {
  return {
    receipt: native.receipt,
    temp: native.temp,
    publishedDigest: native.published?.sha256 ?? null,
    publishedBytes: native.published ? Buffer.from(native.published.bytes).toString() : null,
    publishAttempts: native.counts.publishAttempts,
    durablePublications: native.counts.durablePublications,
    nativeAcks: native.counts.ack,
    remoteGets: remote.gets,
    remoteAcks: remote.acks,
  };
}

describe("companion save survives a crash at every edge of the handoff", () => {
  it("publishes once and acknowledges once when nothing crashes", async () => {
    const native = new FakeNative();
    const remote: Remote = { gets: 0, acks: 0 };
    const out = await service(native, remote).save(INPUT);
    expect(out).toMatchObject({ state: "published", acknowledged: true });
    expect(evidence(native, remote)).toMatchObject({
      receipt: "acknowledged",
      temp: false,
      publishedDigest: DIGEST,
      durablePublications: 1,
      remoteGets: 1,
      remoteAcks: 1,
    });
  });

  for (const crash of ["prepare-before", "prepare-after", "publish-before"] as const)
    it(`${crash}: the retry redoes the work and still publishes exactly once`, async () => {
      const native = new FakeNative();
      const remote: Remote = { gets: 0, acks: 0 };
      native.crash = crash;
      await expect(service(native, remote).save(INPUT)).rejects.toThrow();
      // Nothing durable was produced, so the object is still owed.
      expect(native.published).toBeNull();
      expect(native.receipt).toBe("prepared");

      native.crash = null;
      const out = await service(native, remote).save(INPUT);
      expect(out).toMatchObject({ state: "published", acknowledged: true });
      const ev = evidence(native, remote);
      // One durable file, even though publish-before legitimately made a second attempt: the retry had
      // to redo work that never landed. Counting attempts here would read a correct retry as a duplicate.
      expect(ev.durablePublications).toBe(1);
      expect(ev.publishAttempts).toBe(crash === "publish-before" ? 2 : 1);
      expect(ev.publishedDigest).toBe(DIGEST);
      expect(ev.receipt).toBe("acknowledged");
      expect(ev.temp).toBe(false);
    });

  it("publish-after: the bytes are durable, so the retry never downloads or publishes again", async () => {
    const native = new FakeNative();
    const remote: Remote = { gets: 0, acks: 0 };
    native.crash = "publish-after";
    await expect(service(native, remote).save(INPUT)).rejects.toThrow();

    // The crash happened after fsync. The receipt is what proves it, not the lost reply.
    expect(native.receipt).toBe("published");
    expect(native.published?.sha256).toBe(DIGEST);
    expect(remote.gets).toBe(1);

    native.crash = null;
    const out = await service(native, remote).save(INPUT);
    expect(out).toMatchObject({ state: "published", acknowledged: true });
    const ev = evidence(native, remote);

    // The load-bearing claim: one authoritative local publication across the crash and the retry.
    expect(ev.durablePublications).toBe(1);
    expect(ev.publishAttempts).toBe(1);
    expect(ev.remoteGets).toBe(1);
    expect(ev.receipt).toBe("acknowledged");
  });

  it("ack transport lost: reports published without claiming durability it cannot prove", async () => {
    const native = new FakeNative();
    const remote: Remote = { gets: 0, acks: 0, failAck: true };
    const out = await service(native, remote).save(INPUT);

    // The bytes are on disk and the caller is told so, but acknowledged stays false because the native
    // receipt never reached 'acknowledged'.
    expect(out).toMatchObject({ state: "published", acknowledged: false });
    expect(native.receipt).toBe("published");
    expect(native.counts.ack).toBe(0);

    remote.failAck = false;
    const again = await service(native, remote).save(INPUT);
    expect(again).toMatchObject({ state: "published", acknowledged: true });
    expect(evidence(native, remote)).toMatchObject({ durablePublications: 1, remoteGets: 1, receipt: "acknowledged" });
  });

  it("ack accepted remotely but the receipt is lost: never claims acknowledged", async () => {
    const native = new FakeNative();
    const remote: Remote = { gets: 0, acks: 0 };
    native.crash = "ack-native-after-http";
    const out = await service(native, remote).save(INPUT);

    // The remote was told, but this side cannot prove durability of that fact, so it does not assert it.
    expect(remote.acks).toBe(1);
    expect(out).toMatchObject({ state: "published", acknowledged: false });
    expect(native.receipt).toBe("published");

    native.crash = null;
    const again = await service(native, remote).save(INPUT);
    expect(again).toMatchObject({ state: "published", acknowledged: true });
    expect(evidence(native, remote)).toMatchObject({ durablePublications: 1, remoteGets: 1, receipt: "acknowledged" });
  });

  it("refuses to publish when the delivered bytes do not match the advertised digest", async () => {
    const native = new FakeNative();
    const remote: Remote = { gets: 0, acks: 0, bytes: new TextEncoder().encode("different bytes entirely") };
    await expect(service(native, remote).save(INPUT)).rejects.toThrow("download_integrity");
    expect(native.published).toBeNull();
    expect(native.counts.durablePublications).toBe(0);
    expect(native.receipt).toBe("prepared");
  });

  for (const status of [401, 404] as const)
    it(`stops before any local write when the authority answers ${status}`, async () => {
      const native = new FakeNative();
      const remote: Remote = { gets: 0, acks: 0, failGet: status };
      await expect(service(native, remote).save(INPUT)).rejects.toThrow(`authority_${status}`);
      expect(native.published).toBeNull();
      expect(native.counts.durablePublications).toBe(0);
      expect(native.receipt).toBe("prepared");
    });

  /**
   * The guard that stops the companion telling the user a file is acknowledged when the helper never
   * recorded it. Every other case in this file reaches acknowledged or returns early, so none of them
   * exercises it: removing the throw left the whole suite green until these two were added.
   */
  it("refuses to report acknowledged when the helper does not record the acknowledgement", async () => {
    const native = new FakeNative();
    const remote: Remote = { gets: 0, acks: 0 };
    native.silentAck = true;
    await expect(service(native, remote).save(INPUT)).rejects.toThrow("publication_unknown");

    // The remote was told, the bytes are durable, and the receipt is the only thing missing. Reporting
    // success here would be a durability claim with nothing behind it.
    expect(remote.acks).toBe(1);
    expect(native.receipt).toBe("published");
    expect(native.counts.durablePublications).toBe(1);
  });

  it("refuses an unrecognised receipt state instead of treating it as progress", async () => {
    const native = new FakeNative();
    const remote: Remote = { gets: 0, acks: 0 };
    native.prepareState = "failed";
    await expect(service(native, remote).save(INPUT)).rejects.toThrow("publication_unknown");
    expect(native.counts.durablePublications).toBe(0);
    expect(remote.gets).toBe(0);
    expect(remote.acks).toBe(0);
  });

  it("two concurrent saves of one handle publish one file", async () => {
    const native = new FakeNative();
    const remote: Remote = { gets: 0, acks: 0 };
    const results = await Promise.allSettled([
      service(native, remote).save(INPUT),
      service(native, remote).save(INPUT),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const ev = evidence(native, remote);
    expect(ev.publishedDigest).toBe(DIGEST);
    expect(ev.publishedBytes).toBe(Buffer.from(PAYLOAD).toString());
    expect(ev.receipt).toBe("acknowledged");
  });
});
