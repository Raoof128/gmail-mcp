import { expect, it, vi } from "vitest";
import { runCases, caseResultSchema, type RunIdentity } from "../legacy-run.ts";
import { caseIds } from "../manifest.ts";
const identity: RunIdentity = {
  runId: "11111111-1111-4111-8111-111111111111",
  deploymentVersionId: "22222222-2222-4222-8222-222222222222",
  workerBuildId: "a".repeat(64),
  qualificationEpoch: "qe_" + "A".repeat(43),
  restoreGeneration: "generation",
  manifestSha256: "b".repeat(64),
  startedAt: Date.now(),
};
it("stops after identity drift and seals remaining cases once", async () => {
  let checks = 0;
  const run = vi.fn(() =>
    Promise.resolve().then(() => ({
      result: "pass" as const,
      attempts: 1,
      artifact_sha256: "c".repeat(64),
      limitation: null,
    })),
  );
  const results = await runCases(
    identity,
    "live",
    caseIds.map((id) => ({ id, requiresLive: true, run })),
    {
      verify: () =>
        Promise.resolve().then(() => {
          if (++checks === 2) throw new Error("drift secret");
        }),
      write: () => Promise.resolve().then(() => undefined),
    },
  );
  expect(run).toHaveBeenCalledTimes(1);
  expect(results.results[0]?.result).toBe("fail");
  expect(results.results.slice(1).every((r) => r.result === "not_run")).toBe(true);
  expect(JSON.stringify(results)).not.toContain("secret");
  expect(results.exitCode).toBe(1);
});
it("cannot count synthetic results or missing mandatory cases as live qualification", async () => {
  const result = await runCases(identity, "synthetic", [], {
    verify: () => Promise.resolve().then(() => undefined),
    write: () => Promise.resolve().then(() => undefined),
  });
  expect(result.exitCode).toBe(1);
  expect(result.results).toHaveLength(caseIds.length);
  expect(caseResultSchema.safeParse({ token: "secret" }).success).toBe(false);
});
