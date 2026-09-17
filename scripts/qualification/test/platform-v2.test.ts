import { expect, it, vi } from "vitest";
import { canonicalize } from "../../../worker/src/crypto/canonical.ts";
import { Authorization, identityHash, snapshotOf } from "../contracts.ts";
import { verifyTargetV2 } from "../platform-v2.ts";
import { deploymentConfigFingerprint } from "../platform.ts";
import { digest } from "../private-files.ts";
import { fixture } from "./v2-fixtures.ts";
function setup() {
  const f = fixture();
  const target = structuredClone(f.identity.target);
  const bindings = [
    { name: "WORKER_HOSTNAME", type: "plain_text", text: new URL(target.origin).hostname },
    { name: "RECOVERY_PROFILE", type: "plain_text", text: target.profile },
    { name: "RESTORE_GENERATION", type: "plain_text", text: target.restoreGeneration },
    { name: "DB", type: "d1", id: target.databaseId },
  ];
  const schema = ["protocol2_update_permit", "protocol2_key_delete", "protocol2_staging_delete"].map((name) => ({
    type: "trigger",
    name,
    sql: "fixture",
  }));
  target.configSha256 = deploymentConfigFingerprint(bindings, {});
  target.schemaSha256 = digest(JSON.stringify(schema));
  const authorization = Authorization.parse({
    ...(f.files.get("authorization.json")!.value as object),
    targetHash: identityHash("target", target, canonicalize),
  });
  const receipt = {
    version: 2,
    snapshot: snapshotOf(target),
    bundleSha256: "a".repeat(64),
    platformScriptEtag: "etag",
  };
  const versions = [{ version_id: target.deploymentVersionId, percentage: 100 }];
  const account = {
    credential_version: target.credentialVersion,
    status: "active",
    alias: "fixture",
    google_email: authorization.sender,
  };
  const installation = { schema_version: 5, restore_generation: target.restoreGeneration, mutation_state: "active" };
  const api = vi.fn((path: string, body?: unknown) => {
    if (body) {
      const statements = (body as { batch: { sql: string }[] }).batch;
      expect(statements.every((s) => s.sql.startsWith("SELECT "))).toBe(true);
    }
    return Promise.resolve(
      path.endsWith("/deployments")
        ? { deployments: [{ id: target.deploymentId, created_on: "2026-09-17T00:00:00Z", versions }] }
        : path.includes("/versions/")
          ? { id: target.deploymentVersionId, resources: { script: { etag: "etag" }, bindings, script_runtime: {} } }
          : [schema, [account], [installation]].map((results) => ({ success: true, results })),
    );
  });
  const transport = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ status: "ready" }), {
        headers: { "x-recovery-build": target.workerBuildId, "x-recovery-version": target.deploymentVersionId },
      }),
    ),
  );
  return { target, authorization, receipt, api, transport, versions, account, installation };
}
it("verifies v2 target identity using only platform reads and SELECT queries", async () => {
  const f = setup();
  await expect(verifyTargetV2({ ...f, now: () => 300 })).resolves.toBeUndefined();
  expect(f.transport).toHaveBeenCalledTimes(1);
  expect(f.api).toHaveBeenCalledTimes(3);
});
it.each(["receipt", "authorization", "split", "sender", "grant", "generation", "expiry"])(
  "refuses %s drift",
  async (change) => {
    const f = setup();
    if (change === "receipt") f.receipt.snapshot.configSha256 = "f".repeat(64);
    if (change === "authorization") f.authorization.targetHash = "f".repeat(64);
    if (change === "split") f.versions[0]!.percentage = 50;
    if (change === "sender") f.account.google_email = "other@example.test";
    if (change === "grant") f.account.credential_version++;
    if (change === "generation") f.installation.restore_generation = "other-generation";
    await expect(verifyTargetV2({ ...f, now: () => (change === "expiry" ? 9000 : 300) })).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
  },
);
it("rechecks authorization expiry after platform and health reads", async () => {
  const f = setup();
  await expect(verifyTargetV2({ ...f, now: () => (f.transport.mock.calls.length ? 9000 : 300) })).rejects.toThrow(
    "intent_expired",
  );
  expect(f.transport).toHaveBeenCalledTimes(1);
});
