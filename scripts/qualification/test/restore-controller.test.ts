import { expect, it } from "vitest";
import { canonicalize } from "../../../worker/src/crypto/canonical.ts";
import { Authorization, identityHash, snapshotOf } from "../contracts.ts";
import { prepareRestore, RestoreManifest } from "../controllers/restore.ts";
import { QuiescenceVerifier } from "../controllers/quiescence.ts";
import { fixture } from "./v2-fixtures.ts";
async function restoreFixture() {
  const f = fixture();
  const authorization = {
    ...Authorization.parse(await f.sink.read(f.closure.authorization)),
    capabilities: ["restore"],
  };
  const manifest = {
    version: 2,
    purpose: "restore",
    target: f.identity.target,
    authorization: f.put("restore-auth.json", authorization),
    restore: {
      version: 2,
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
it("publishes private preparation without granting restore authority", async () => {
  const f = await restoreFixture();
  const receipt = await prepareRestore(f.manifest, f.sink, () => f.identity.startedAt);
  expect(receipt).toMatchObject({ version: 2, state: "not_run", reason: "quiescence_unavailable" });
  expect(receipt).not.toHaveProperty("bookmark");
  expect(receipt).not.toHaveProperty("authorization");
});
it("refuses v1 drained booleans and substituted generations or authorizations", async () => {
  const f = await restoreFixture();
  expect(RestoreManifest.safeParse({ ...f.manifest, drained: true }).success).toBe(false);
  await expect(
    prepareRestore(
      { ...f.manifest, restore: { ...f.manifest.restore, generation: "other" } },
      f.sink,
      () => f.identity.startedAt,
    ),
  ).rejects.toThrow();
  await expect(
    prepareRestore(
      { ...f.manifest, restore: { ...f.manifest.restore, authorizationSha256: "b".repeat(64) } },
      f.sink,
      () => f.identity.startedAt,
    ),
  ).rejects.toThrow();
  await expect(prepareRestore(f.manifest, f.sink, () => f.manifest.restore.authorizationExpiresAt)).rejects.toThrow(
    "intent_expired",
  );
});
it("cannot mint verified quiescence by parsing a valid target", async () => {
  const f = await restoreFixture();
  await expect(new QuiescenceVerifier().verify(f.manifest.restore)).rejects.toThrow("quiescence_unavailable");
});
