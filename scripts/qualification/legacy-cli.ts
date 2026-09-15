/** Historical synthetic runner. This module cannot dispatch live or administrative commands. */
import { artifactSchema } from "./artifacts.ts";
import { caseRegistry } from "./cases/index.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preflight } from "./preflight.ts";
import { withDeploymentLock } from "./lock.ts";
import { writePrivateJson } from "./private-files.ts";
import { runCases, type RunIdentity } from "./legacy-run.ts";
export async function main(args: string[]): Promise<number> {
  const [command, flag, path, mode, ...extra] = args;
  if (command !== "run" || flag !== "--manifest" || !path || mode !== "--synthetic" || extra.length)
    throw new Error("legacy qualification supports local synthetic runs only");
  const { manifest: m, receipt, directory, manifestHash } = await preflight(path);
  if (!m.expectedEpoch || !m.runResult || resolve(m.runResult) !== resolve(directory, basename(m.runResult)))
    throw new Error("synthetic result scope required");
  const resultName = basename(m.runResult);
  return withDeploymentLock(m, async () => {
    const identity: RunIdentity = {
      runId: randomUUID(),
      deploymentVersionId: m.deploymentVersionId,
      workerBuildId: m.workerBuildId,
      qualificationEpoch: m.expectedEpoch!,
      restoreGeneration: m.restoreGeneration,
      manifestSha256: manifestHash,
      startedAt: Date.now(),
      ...(receipt.companionBuildId ? { companionBuildId: receipt.companionBuildId } : {}),
      ...(receipt.nativeBuildId ? { nativeBuildId: receipt.nativeBuildId } : {}),
    };
    const synthetic = true;
    const verify = () => Promise.resolve();
    const cases = caseRegistry({
      manifest: m,
      synthetic,
      local: async (files, run, caseId) => {
        try {
          const result = await promisify(execFile)(
            "npm",
            ["test", "-w", "@gmail-mcp/worker", "--", "--run", ...files.map((f) => `test/${f}`)],
            {
              cwd: fileURLToPath(new URL("../../", import.meta.url)),
              timeout: 120000,
              maxBuffer: 1048576,
              env: { ...process.env, NO_COLOR: "1", CI: "1" },
            },
          );
          const passed = Number(/Tests\s+(\d+) passed/.exec(result.stdout)?.[1] ?? 0);
          if (!passed) throw new Error("test summary missing");
          const artifact = await writePrivateJson(
            directory,
            `${run.runId}-${caseId}-artifact.json`,
            artifactSchema.parse({
              version: 1,
              mode: "synthetic",
              run_id: run.runId,
              case_id: caseId,
              manifest_sha256: run.manifestSha256,
              worker_build: run.workerBuildId,
              tests: files,
              passed,
            }),
          );
          return { result: "pass", attempts: 1, artifact_sha256: artifact, limitation: null };
        } catch {
          return { result: "fail", attempts: 1, artifact_sha256: null, limitation: "case_failed" };
        }
      },
    }).filter((c) => m.caseIds.includes(c.id));
    const report = await runCases(identity, synthetic ? "synthetic" : "live", cases, {
      verify,
      write: async (row) => {
        await writePrivateJson(directory, `${identity.runId}-${row.case_id}.json`, row);
      },
    });
    await writePrivateJson(directory, resultName, report);
    return report.exitCode;
  });
}
