import { describe, expect, it } from "vitest";
import { canonicalize } from "../../../worker/src/crypto/canonical.ts";
import { Authorization, identityHash, snapshotOf } from "../contracts.ts";
import { prepareRestore } from "../controllers/restore.ts";
import { fixture } from "./v2-fixtures.ts";

/**
 * One case per refusal predicate in prepareRestore, so each can be neutralised on its own and the
 * single case that names it turns red. A guard covered only by a case that also trips a neighbouring
 * guard is a guard nobody is testing.
 *
 * Everything downstream of the refusal is not_run rather than passing: no restore request can be
 * issued, so there is no ambiguous response to reconcile and no post-restore evidence to read.
 */
async function restoreFixture(capabilities: string[] = ["restore"]) {
  const f = fixture();
  const authorization = {
    ...Authorization.parse(await f.sink.read(f.closure.authorization)),
    capabilities,
  };
  const manifest = {
    version: 2 as const,
    purpose: "restore" as const,
    target: f.identity.target,
    authorization: f.put("restore-predicates-auth.json", authorization),
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
  return { ...f, manifest, authorization };
}
const at = (f: Awaited<ReturnType<typeof restoreFixture>>) => () => f.identity.startedAt;

describe("each restore refusal predicate, one case apiece", () => {
  it("accepts a well formed manifest as far as the quiescence gate and no further", async () => {
    const f = await restoreFixture();
    // The control. Every case below asserts a refusal, which means nothing unless this one gets past
    // the identity checks. It stops at quiescence, which is the standing feasibility gate.
    expect(await prepareRestore(f.manifest, f.sink, at(f))).toMatchObject({
      version: 2,
      state: "not_run",
      reason: "quiescence_unavailable",
    });
  });

  it("refuses a snapshot that is not the target's own", async () => {
    const f = await restoreFixture();
    const restore = {
      ...f.manifest.restore,
      snapshot: { ...f.manifest.restore.snapshot, deploymentId: "00000000-0000-4000-8000-000000000099" },
    };
    await expect(prepareRestore({ ...f.manifest, restore }, f.sink, at(f))).rejects.toThrow("missing_authorization");
  });

  it("refuses an authorization issued for a different target", async () => {
    const f = await restoreFixture();
    const authorization = { ...f.authorization, targetHash: "b".repeat(64) };
    const manifest = {
      ...f.manifest,
      authorization: f.put("wrong-target-auth.json", authorization),
      restore: {
        ...f.manifest.restore,
        authorizationSha256: identityHash("authorization", authorization, canonicalize),
      },
    };
    await expect(prepareRestore(manifest, f.sink, at(f))).rejects.toThrow("missing_authorization");
  });

  it("refuses when the restore target names a different authorization than the one supplied", async () => {
    const f = await restoreFixture();
    const restore = { ...f.manifest.restore, authorizationSha256: "c".repeat(64) };
    await expect(prepareRestore({ ...f.manifest, restore }, f.sink, at(f))).rejects.toThrow("missing_authorization");
  });

  it("refuses an intent that outlives the authorization behind it", async () => {
    const f = await restoreFixture();
    const restore = { ...f.manifest.restore, authorizationExpiresAt: f.authorization.expiresAt + 1 };
    await expect(prepareRestore({ ...f.manifest, restore }, f.sink, at(f))).rejects.toThrow("missing_authorization");
  });

  it("refuses an authorization that does not carry the restore capability", async () => {
    const f = await restoreFixture(["send", "deploy", "power-loss"]);
    await expect(prepareRestore(f.manifest, f.sink, at(f))).rejects.toThrow("missing_authorization");
  });

  it("refuses once the intent has expired, separately from the authorization checks", async () => {
    const f = await restoreFixture();
    // Everything else is well formed, so this is the expiry clause alone.
    await expect(prepareRestore(f.manifest, f.sink, () => f.manifest.restore.authorizationExpiresAt)).rejects.toThrow(
      "intent_expired",
    );
  });
});
