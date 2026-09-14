import { validateLiveArtifact } from "./artifacts.ts";
import { resolve, dirname } from "node:path";
import { caseIds, type Manifest } from "./manifest.ts";
import { runReportSchema, caseResultSchema } from "./run.ts";
import { digest, readPrivateJson, readPrivateBytes } from "./private-files.ts";
import type { EnableEvidence } from "./admin.ts";
export async function loadEnableEvidence(m: Manifest, manifestHash: string): Promise<EnableEvidence> {
  if (!m.runResult || dirname(resolve(m.runResult)) !== resolve(m.privateDirectory))
    throw new Error("sealed run required");
  const reportBytes = await readPrivateBytes(m.runResult);
  const report = runReportSchema.parse(JSON.parse(reportBytes.toString("utf8")));
  if (
    report.mode !== "live" ||
    report.exitCode !== 0 ||
    report.identity.manifestSha256 !== manifestHash ||
    report.identity.workerBuildId !== m.workerBuildId ||
    report.identity.deploymentVersionId !== m.deploymentVersionId ||
    report.identity.restoreGeneration !== m.restoreGeneration ||
    report.identity.qualificationEpoch !== m.expectedEpoch ||
    report.results.some((r) => r.result !== "pass") ||
    new Set(report.results.map((r) => r.case_id)).size !== caseIds.length
  )
    throw new Error("live qualification evidence refused");
  return {
    mode: "live",
    runId: report.identity.runId,
    runSha256: digest(reportBytes),
    manifestSha256: manifestHash,
    qualificationEpoch: report.identity.qualificationEpoch,
    verify: async (current) => {
      if (
        current.expectedEpoch !== report.identity.qualificationEpoch ||
        current.workerBuildId !== report.identity.workerBuildId ||
        current.deploymentVersionId !== report.identity.deploymentVersionId
      )
        throw new Error("run identity changed");
      for (const row of report.results) {
        const path = resolve(current.privateDirectory, `${report.identity.runId}-${row.case_id}.json`);
        const stored = caseResultSchema.parse(await readPrivateJson(path));
        if (
          JSON.stringify(stored) !== JSON.stringify(row) ||
          row.run_id !== report.identity.runId ||
          row.deployment_version_id !== report.identity.deploymentVersionId ||
          row.worker_build !== report.identity.workerBuildId ||
          row.manifest_sha256 !== manifestHash
        )
          throw new Error("case identity changed");
        // The referenced artifact is separately schema-checked on write and cannot be replaced by a result row.
        const artifact = resolve(current.privateDirectory, `${report.identity.runId}-${row.case_id}-artifact.json`);
        const bytes = await readPrivateBytes(artifact);
        const verified = validateLiveArtifact(JSON.parse(bytes.toString("utf8")));
        if (
          verified.run_id !== report.identity.runId ||
          verified.case_id !== row.case_id ||
          verified.manifest_sha256 !== manifestHash ||
          verified.worker_build !== report.identity.workerBuildId
        )
          throw new Error("artifact identity changed");
        if (digest(bytes) !== row.artifact_sha256) throw new Error("artifact digest changed");
      }
    },
  };
}
