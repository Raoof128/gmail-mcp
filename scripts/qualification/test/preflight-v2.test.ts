import { expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize } from "../../../worker/src/crypto/canonical.ts";
import { identityHash, snapshotOf } from "../contracts.ts";
import { createPrivateSink } from "../private-files.ts";
import { preflightV2 } from "../preflight-v2.ts";
import { executeV2 } from "../cli.ts";
import { RunReportV2 } from "../run-v2.ts";
import { fixture } from "./v2-fixtures.ts";
it("validates private component input relationships without promoting exclusion claims to proof", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "qualification-v2-preflight-"));
  try {
    const f = fixture(),
      sink = await createPrivateSink(directory);
    const auth = await sink.write("authorization.json", f.files.get("authorization.json")!.value);
    const preparation = await sink.write("preparation.json", {
      version: 2,
      identity: f.closure.identity,
      authorization: auth,
      intentRefs: [],
    });
    const receipt = await sink.write("deployment.json", {
      version: 2,
      snapshot: snapshotOf(f.identity.target),
      bundleSha256: "b".repeat(64),
      platformScriptEtag: "etag",
    });
    const exclusion = await sink.write("exclusion.json", { callerClaim: true });
    const manifest = {
      version: 2,
      target: f.identity.target,
      authorization: auth,
      privateDirectory: directory,
      deploymentReceipt: receipt,
      deploymentExclusionEvidence: exclusion,
      resultName: "result.json",
      purpose: "release-component",
      phase: "run",
      caseIds: ["physical-durability"],
      preparation,
      preparationCommitment: identityHash(
        "preparation-commitment",
        { identity: f.closure.identity, intentRefs: [] },
        canonicalize,
      ),
    };
    await sink.write("manifest.json", manifest);
    const result = await preflightV2(join(directory, "manifest.json"), "run", 500);
    expect(result.preparation?.identity.allocations).toHaveLength(3);
    expect(await executeV2(result)).toBe(1);
    const run = vi.fn();
    expect(
      await executeV2(result, {
        now: () => 500,
        verifyLiveTargetAndExclusion: () => Promise.reject(new Error("unproven")),
        run,
      }),
    ).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(result.exclusion).toEqual({ callerClaim: true }); // Still unverified; CLI must gate it.
    await expect(preflightV2(join(directory, "manifest.json"), "enable", 500)).rejects.toThrow("phase");
    await expect(preflightV2(join(directory, "manifest.json"), "run", 10000)).rejects.toThrow();
    await sink.write("bad.json", { ...manifest, preparationCommitment: "0".repeat(64) });
    await expect(preflightV2(join(directory, "bad.json"), "run", 500)).rejects.toThrow("commitment");
    const complete = fixture({ manifestSha256: result.manifestHash });
    for (const [name, value] of complete.files) {
      if (name !== "authorization.json") await sink.write(name, value.value);
    }
    const verify = vi.fn(() => Promise.resolve());
    expect(
      await executeV2(result, {
        now: () => 500,
        verifyLiveTargetAndExclusion: verify,
        run: () =>
          Promise.resolve(
            RunReportV2.parse({ version: 2, identity: complete.identity, report: complete.report, exitCode: 0 }),
          ),
      }),
    ).toBe(0);
    expect(verify).toHaveBeenCalledTimes(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
