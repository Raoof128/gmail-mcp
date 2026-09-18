import { expect, it, vi } from "vitest";
import { canonicalize } from "../../../worker/src/crypto/canonical.ts";
import { Authorization, identityHash, snapshotOf } from "../contracts.ts";
import { verifyTargetV2 } from "../platform-v2.ts";
import { deploymentConfigFingerprint } from "../platform.ts";
import { digest } from "../private-files.ts";
import { fixture } from "./v2-fixtures.ts";

/**
 * The chain from a local production input to the code actually receiving the qualified traffic. The
 * point of each case is that qualification evidence must describe what is serving now, not a deployment
 * object that once existed, so the strongest checks are the ones the running Worker answers for itself.
 */
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
  const served = { build: target.workerBuildId, version: target.deploymentVersionId, ok: true };
  const platform = {
    deploymentId: target.deploymentId,
    versions: [{ version_id: target.deploymentVersionId, percentage: 100 }],
    etag: "etag",
    versionId: target.deploymentVersionId,
    bindings,
    schema,
  };
  const api = vi.fn((path: string) =>
    Promise.resolve(
      path.endsWith("/deployments")
        ? {
            deployments: [
              { id: platform.deploymentId, created_on: "2026-09-17T00:00:00Z", versions: platform.versions },
            ],
          }
        : path.includes("/versions/")
          ? {
              id: platform.versionId,
              resources: { script: { etag: platform.etag }, bindings: platform.bindings, script_runtime: {} },
            }
          : [
              platform.schema,
              [
                {
                  credential_version: target.credentialVersion,
                  status: "active",
                  alias: "fixture",
                  google_email: authorization.sender,
                },
              ],
              [{ schema_version: 5, restore_generation: target.restoreGeneration, mutation_state: "active" }],
            ].map((results) => ({ success: true, results })),
    ),
  );
  const transport = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ status: "ready" }), {
        status: served.ok ? 200 : 503,
        headers: { "x-recovery-build": served.build, "x-recovery-version": served.version },
      }),
    ),
  );
  return { target, authorization, receipt, api, transport, served, platform };
}
const run = (f: ReturnType<typeof setup>) =>
  verifyTargetV2({
    target: f.target,
    authorization: f.authorization,
    receipt: f.receipt,
    api: f.api,
    transport: f.transport,
    now: () => 300,
  });

it("accepts a target whose routed version and served build both match", async () => {
  await expect(run(setup())).resolves.toBeUndefined();
});

it("refuses when the serving Worker reports a different build than the target claims", async () => {
  const f = setup();
  // The platform side is entirely consistent; only the code answering /healthz disagrees.
  f.served.build = "b".repeat(64);
  await expect(run(f)).rejects.toThrow();
});

it("refuses when the serving Worker reports a different version than the routed one", async () => {
  const f = setup();
  f.served.version = "00000000-0000-4000-8000-000000000099";
  await expect(run(f)).rejects.toThrow();
});

it("refuses a deployment object that is no longer the active one", async () => {
  const f = setup();
  f.platform.deploymentId = "00000000-0000-4000-8000-000000000098";
  await expect(run(f)).rejects.toThrow();
});

it("refuses when the active deployment routes a different version", async () => {
  const f = setup();
  f.platform.versions = [{ version_id: "00000000-0000-4000-8000-000000000097", percentage: 100 }];
  await expect(run(f)).rejects.toThrow();
});

it("refuses a stale receipt whose script etag no longer matches the version", async () => {
  const f = setup();
  f.platform.etag = "a-newer-etag";
  await expect(run(f)).rejects.toThrow();
});

it("refuses when a configuration binding has changed under the deployment", async () => {
  const f = setup();
  // Built explicitly rather than spread: exactOptionalPropertyTypes rejects a member carrying both the
  // plain_text and d1 shapes.
  f.platform.bindings = f.platform.bindings.map((b) =>
    b.name === "DB" ? { name: "DB", type: "d1", id: "00000000-0000-4000-8000-000000000096" } : b,
  );
  await expect(run(f)).rejects.toThrow();
});

it("refuses when a protocol-2 schema marker is missing", async () => {
  const f = setup();
  f.platform.schema = f.platform.schema.filter((row) => row.name !== "protocol2_key_delete");
  await expect(run(f)).rejects.toThrow();
});

it("refuses an unhealthy Worker even when every identifier lines up", async () => {
  const f = setup();
  f.served.ok = false;
  await expect(run(f)).rejects.toThrow();
});
