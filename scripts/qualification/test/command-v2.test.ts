import { expect, it, vi } from "vitest";
import { executeV2 } from "../cli.ts";
import { Authorization, CaseReport, ComponentRunManifest, snapshotOf } from "../contracts.ts";
import { DeploymentReceiptV2, PreparationCommitmentRecord, type LocalPreflightV2 } from "../preflight-v2.ts";
import { RunReportV2 } from "../run-v2.ts";
import { fixture } from "./v2-fixtures.ts";
function localFixture() {
  const f = fixture();
  const ref = { name: "input.json", sha256: "a".repeat(64) };
  const local: LocalPreflightV2 = {
    manifest: ComponentRunManifest.parse({
      version: 2,
      purpose: "release-component",
      phase: "run",
      target: f.identity.target,
      authorization: ref,
      privateDirectory: "/private/test",
      deploymentReceipt: ref,
      deploymentExclusionEvidence: ref,
      resultName: "run.json",
      preparation: ref,
      preparationCommitment: f.identity.preparationCommitment,
      caseIds: ["physical-durability"],
    }),
    manifestHash: f.identity.manifestSha256,
    directory: "/private/test",
    sink: f.sink,
    authorization: Authorization.parse(f.files.get("authorization.json")!.value),
    receipt: DeploymentReceiptV2.parse({
      version: 2,
      snapshot: snapshotOf(f.identity.target),
      bundleSha256: "a".repeat(64),
      platformScriptEtag: "etag",
    }),
    exclusion: {},
    preparation: PreparationCommitmentRecord.parse({
      version: 2,
      identity: f.closure.identity,
      authorization: ref,
      intentRefs: [],
    }),
  };
  return { f, local, report: RunReportV2.parse({ version: 2, identity: f.identity, report: f.report, exitCode: 0 }) };
}
it("refuses expired authority before verification or dispatch", async () => {
  const { local } = localFixture();
  const verify = vi.fn();
  const run = vi.fn();
  expect(await executeV2(local, { now: () => 9000, verifyLiveTargetAndExclusion: verify, run })).toBe(1);
  expect(verify).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});
it("seals a late target failure instead of publishing the earlier passing verdict", async () => {
  const { f, local, report } = localFixture();
  let checks = 0;
  expect(
    await executeV2(local, {
      now: () => 500,
      verifyLiveTargetAndExclusion: () =>
        ++checks === 2 ? Promise.reject(new Error("private failure")) : Promise.resolve(),
      run: () => Promise.resolve(report),
    }),
  ).toBe(1);
  const stored = CaseReport.parse(f.files.get(`case-${f.identity.runId}.json`)!.value);
  expect(stored.result).toBe("fail");
  expect(stored.limitation).toBe("identity_drift");
  expect(stored.observationRefs).toHaveLength(3);
  expect(JSON.stringify(stored)).not.toContain("private failure");
});
it("rechecks intent expiry after a slow target guard before controller dispatch", async () => {
  const { local } = localFixture();
  let time = 500;
  const run = vi.fn();
  expect(
    await executeV2(local, {
      now: () => time,
      verifyLiveTargetAndExclusion: () => {
        time = 9000;
        return Promise.resolve();
      },
      run,
    }),
  ).toBe(1);
  expect(run).not.toHaveBeenCalled();
});
it("does not expose administrative commands through the legacy synthetic entry", async () => {
  const legacy = await import("../legacy-cli.ts");
  await expect(legacy.main(["probe", "--manifest", "/not-read", "--synthetic"])).rejects.toThrow("synthetic");
  await expect(legacy.main(["run", "--manifest", "/not-read"])).rejects.toThrow("synthetic");
});
it("does not let a handler extend the authorization snapshot after dispatch", async () => {
  const { local, report, f } = localFixture();
  let time = 500;
  expect(
    await executeV2(local, {
      now: () => time,
      verifyLiveTargetAndExclusion: () => Promise.resolve(),
      run: () => {
        local.authorization.expiresAt = 999999;
        time = 9000;
        return Promise.resolve(report);
      },
    }),
  ).toBe(1);
  const stored = CaseReport.parse(f.files.get(`case-${f.identity.runId}.json`)!.value);
  expect(stored.result).toBe("fail");
  expect(stored.limitation).toBe("intent_expired");
});
