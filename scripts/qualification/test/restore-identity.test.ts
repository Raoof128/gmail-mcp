import { expect, it, vi } from "vitest";
import { canonicalize } from "../../../worker/src/crypto/canonical.ts";
import { Authorization, RestoreTarget, identityHash, snapshotOf } from "../contracts.ts";
import { RestoreManifest } from "../controllers/restore.ts";
import { fixture } from "./v2-fixtures.ts";

/**
 * Restore has no implementation on purpose: nothing here can issue a Time Travel request, so the live
 * half of the restore matrix is not_run rather than passing. What is reachable is the identity the
 * request would have to carry, and the guarantee that no amount of local preparation can start one.
 */
async function restoreFixture() {
  const f = fixture();
  const authorization = {
    ...Authorization.parse(await f.sink.read(f.closure.authorization)),
    capabilities: ["restore"],
  };
  const manifest = {
    version: 2,
    purpose: "restore" as const,
    target: f.identity.target,
    authorization: f.put("restore-identity-auth.json", authorization),
    restore: {
      version: 2 as const,
      snapshot: snapshotOf(f.identity.target),
      databaseId: f.identity.target.databaseId,
      bookmark: "bookmark",
      authorizationSha256: identityHash("authorization", authorization, canonicalize),
      authorizationExpiresAt: authorization.expiresAt,
      generation: f.identity.target.restoreGeneration,
      routedVersionsSha256: "a".repeat(64),
    },
  };
  return { ...f, manifest };
}

it("binds the restore generation to the snapshot's own generation in the schema", async () => {
  const f = await restoreFixture();
  const good = f.manifest.restore;
  expect(RestoreTarget.safeParse(good).success).toBe(true);

  // The duplicate is not a second source of truth: the type refuses any pair that disagrees, in either
  // direction, so no call site can forget to compare them.
  expect(RestoreTarget.safeParse({ ...good, generation: "other-generation" }).success).toBe(false);
  expect(
    RestoreTarget.safeParse({ ...good, snapshot: { ...good.snapshot, restoreGeneration: "other-generation" } }).success,
  ).toBe(false);

  // The same holds for the database the bookmark belongs to.
  expect(RestoreTarget.safeParse({ ...good, databaseId: "44444444-4444-4444-8444-444444444444" }).success).toBe(false);
  expect(
    RestoreTarget.safeParse({
      ...good,
      snapshot: { ...good.snapshot, databaseId: "44444444-4444-4444-8444-444444444444" },
    }).success,
  ).toBe(false);
});

it("refuses a manifest whose restore snapshot is not the target's own", async () => {
  const f = await restoreFixture();
  const { prepareRestore } = await import("../controllers/restore.ts");
  for (const field of ["deploymentVersionId", "workerBuildId", "configSha256"] as const) {
    const substituted = {
      ...f.manifest.restore.snapshot,
      [field]: field === "deploymentVersionId" ? "55555555-5555-4555-8555-555555555555" : "c".repeat(64),
    };
    await expect(
      prepareRestore(
        { ...f.manifest, restore: { ...f.manifest.restore, snapshot: substituted } },
        f.sink,
        () => f.identity.startedAt,
      ),
    ).rejects.toThrow("missing_authorization");
  }
});

it("refuses a drained boolean and any manifest field the schema does not know", async () => {
  const f = await restoreFixture();
  expect(RestoreManifest.safeParse({ ...f.manifest, drained: true }).success).toBe(false);
  expect(RestoreManifest.safeParse({ ...f.manifest, force: true }).success).toBe(false);
  expect(RestoreManifest.safeParse({ ...f.manifest, version: 1 }).success).toBe(false);
});

/**
 * The comment in the controller says adding a supported verifier must not silently activate an
 * unreviewed restore implementation. While the real verifier always refuses, that line cannot run, so
 * the claim was untested. Replacing the verifier module is the only way to reach it without changing
 * production code.
 */
it("still refuses once quiescence is satisfied, rather than proceeding to a restore", async () => {
  vi.resetModules();
  vi.doMock("../controllers/quiescence.ts", () => ({
    QuiescenceVerifier: class {
      verify(input: unknown) {
        return Promise.resolve(input as never);
      }
    },
  }));
  try {
    const { prepareRestore } = await import("../controllers/restore.ts");
    const f = await restoreFixture();
    await expect(prepareRestore(f.manifest, f.sink, () => f.identity.startedAt)).rejects.toThrow(
      "restore_controller_unavailable",
    );
  } finally {
    vi.doUnmock("../controllers/quiescence.ts");
    vi.resetModules();
  }
});

it("exposes no platform port, so preparation cannot reach Time Travel", async () => {
  const f = await restoreFixture();
  const { prepareRestore } = await import("../controllers/restore.ts");
  const reads: string[] = [];
  const sink = {
    ...f.sink,
    read: (ref: { path: string }) => {
      reads.push(ref.path);
      return f.sink.read(ref as never);
    },
    write: () => {
      throw new Error("preparation must not write");
    },
  };
  const receipt = await prepareRestore(f.manifest, sink as never, () => f.identity.startedAt);

  // The only capability preparation has is reading its own authorization out of the private sink.
  expect(reads.length).toBeGreaterThan(0);
  expect(receipt).toMatchObject({ version: 2, state: "not_run", reason: "quiescence_unavailable" });
  expect(prepareRestore.length).toBeLessThanOrEqual(3);
  expect(JSON.stringify(receipt)).not.toContain("bookmark");
});
