import { expect, it } from "vitest";
import { verifyDeployment } from "../platform.ts";
import { fixtureManifest } from "./fixtures.ts";
it("refuses traffic splits before reading database state", async () => {
  let calls = 0;
  const m = fixtureManifest();
  await expect(
    verifyDeployment(
      m,
      {
        version: 1,
        workerBuildId: m.workerBuildId,
        deploymentVersionId: m.deploymentVersionId,
        deploymentId: m.deploymentId,
        restoreGeneration: m.restoreGeneration,
        compatibilityVersion: 3,
        bundleSha256: "a".repeat(64),
        schemaSha256: "a".repeat(64),
        configSha256: "a".repeat(64),
        platformScriptEtag: "etag",
      },
      () =>
        Promise.resolve().then(() => {
          calls++;
          return {
            deployments: [
              {
                id: m.deploymentId,
                created_on: new Date().toISOString(),
                versions: [{ version_id: m.deploymentVersionId, percentage: 50 }],
              },
            ],
          };
        }),
      () => Promise.resolve().then(() => new Response()),
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
it("refuses a changed qualification epoch during a frozen run", async () => {
  const { verifyQualification } = await import("../platform.ts");
  const m = { ...fixtureManifest(), expectedEpoch: "qe_" + "A".repeat(43) };
  await expect(
    verifyQualification(m, () =>
      Promise.resolve([
        {
          success: true,
          results: [
            { epoch: "qe_" + "B".repeat(43), state: "enabled", expires_at: Date.now() + 60000, probe_ids: "[]" },
          ],
        },
      ]),
    ),
  ).rejects.toThrow();
});
it("excludes secret values and rejects secrets misconfigured as plaintext", async () => {
  const { deploymentConfigFingerprint } = await import("../platform.ts");
  const config = { name: "GOOGLE_CLIENT_SECRET", type: "secret_text", text: "first" };
  expect(deploymentConfigFingerprint([config], {})).toBe(
    deploymentConfigFingerprint([{ ...config, text: "second" }], {}),
  );
  expect(() => deploymentConfigFingerprint([{ ...config, type: "plain_text" }], {})).toThrow();
});
it("checks fixture alias and sender against the authoritative account before Worker traffic", async () => {
  const { deploymentConfigFingerprint } = await import("../platform.ts");
  const { digest } = await import("../private-files.ts");
  const m = {
    ...fixtureManifest(),
    accountAlias: "primary",
    authorization: {
      sender: "sender@example.com",
      recipient: "recipient@example.com",
      expiresAt: Date.now() + 60000,
      capabilities: ["send" as const],
      reference: "operator-test",
    },
  };
  const bindings = [
    { name: "WORKER_HOSTNAME", type: "plain_text", text: new URL(m.origin).hostname },
    { name: "RECOVERY_PROFILE", type: "plain_text", text: m.profile },
    { name: "RESTORE_GENERATION", type: "plain_text", text: m.restoreGeneration },
    { name: "DB", type: "d1", id: m.databaseId },
  ];
  const schema = ["protocol2_update_permit", "protocol2_key_delete", "protocol2_staging_delete"].map((name) => ({
    type: "trigger",
    name,
    sql: "fixture",
  }));
  const receipt = {
    version: 1 as const,
    workerBuildId: m.workerBuildId,
    deploymentVersionId: m.deploymentVersionId,
    deploymentId: m.deploymentId,
    restoreGeneration: m.restoreGeneration,
    compatibilityVersion: 3 as const,
    bundleSha256: "a".repeat(64),
    schemaSha256: digest(JSON.stringify(schema)),
    configSha256: deploymentConfigFingerprint(bindings, {}),
    platformScriptEtag: "etag",
  };
  let workerCalls = 0;
  const transport = () => {
    workerCalls++;
    return Promise.resolve(
      new Response(JSON.stringify({ status: "ready" }), {
        headers: {
          "x-recovery-build": m.workerBuildId,
          "x-recovery-version": m.deploymentVersionId,
        },
      }),
    );
  };
  for (const [alias, email, accepted] of [
    ["primary", "sender@example.com", true],
    ["other", "sender@example.com", false],
    ["primary", "other@example.com", false],
  ] as const) {
    const api = (path: string) =>
      Promise.resolve(
        path.endsWith("/deployments")
          ? {
              deployments: [
                {
                  id: m.deploymentId,
                  created_on: new Date().toISOString(),
                  versions: [{ version_id: m.deploymentVersionId, percentage: 100 }],
                },
              ],
            }
          : path.includes("/versions/")
            ? {
                id: m.deploymentVersionId,
                resources: { script: { etag: "etag" }, bindings, script_runtime: {} },
              }
            : [
                schema,
                [{ credential_version: 1, status: "active", alias, google_email: email }],
                [{ schema_version: 5, restore_generation: m.restoreGeneration, mutation_state: "active" }],
              ].map((results) => ({ success: true, results })),
      );
    if (accepted) await verifyDeployment(m, receipt, api, transport);
    else await expect(verifyDeployment(m, receipt, api, transport)).rejects.toThrow();
  }
  expect(workerCalls).toBe(1);
});
