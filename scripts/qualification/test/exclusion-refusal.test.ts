import { expect, it, vi } from "vitest";
import { executeV2, CommandStatus } from "../cli.ts";
import { Authorization, ComponentRunManifest, snapshotOf } from "../contracts.ts";
import { DeploymentReceiptV2, PreparationCommitmentRecord, type LocalPreflightV2 } from "../preflight-v2.ts";
import { fixture } from "./v2-fixtures.ts";

/**
 * Cross-host deployment exclusion is a standing feasibility gate: nothing here can demonstrate that no
 * other host holds deployment authority, so the command refuses. The refusal itself is ordinary code and
 * is expected to pass. What stays not_run is the external guarantee, and the record written on the way
 * out is what says so.
 */
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
  return { f, local };
}
const statuses = (f: ReturnType<typeof localFixture>["f"]) =>
  [...f.files.entries()]
    .filter(([name]) => name.startsWith("command-"))
    .map(([, file]) => CommandStatus.parse(file.value));

it("refuses with no live mechanism at all, before any credential access or dispatch", async () => {
  const { f, local } = localFixture();
  expect(await executeV2(local)).toBe(1);
  const written = statuses(f);
  expect(written).toHaveLength(1);
  expect(written[0]).toMatchObject({
    result: "not_run",
    limitation: "deployment_exclusion_unavailable",
    command: "run",
    manifestSha256: f.identity.manifestSha256,
  });
});

it("refuses when the exclusion check itself fails, and never dispatches the run", async () => {
  const { f, local } = localFixture();
  const run = vi.fn();
  expect(
    await executeV2(local, {
      now: () => 500,
      verifyLiveTargetAndExclusion: () => Promise.reject(new Error("another host holds deployment authority")),
      run,
    }),
  ).toBe(1);
  expect(run).not.toHaveBeenCalled();
  const written = statuses(f);
  expect(written).toHaveLength(1);
  expect(written[0]).toMatchObject({ result: "not_run", limitation: "deployment_exclusion_unavailable" });
  // The private failure text never reaches the record.
  expect(JSON.stringify(written[0])).not.toContain("another host");
});

it("records not_run rather than a pass, which is what keeps the gate open", async () => {
  const { f, local } = localFixture();
  await executeV2(local);
  // CommandStatus pins result to the literal "not_run", so a passing verdict cannot be recorded here
  // even by mistake.
  expect(() => CommandStatus.parse({ ...statuses(f)[0], result: "pass" })).toThrow();
});
