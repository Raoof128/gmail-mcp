import { z } from "zod";
import { caseIds, hash } from "./manifest.ts";
export const runIdentitySchema = z
  .object({
    runId: z.string().uuid(),
    deploymentVersionId: z.string().uuid(),
    workerBuildId: hash,
    companionBuildId: hash.optional(),
    nativeBuildId: hash.optional(),
    qualificationEpoch: z.string().regex(/^qe_[A-Za-z0-9_-]{43}$/),
    restoreGeneration: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
    manifestSha256: hash,
    startedAt: z.number().int().nonnegative(),
  })
  .strict();
export type RunIdentity = z.infer<typeof runIdentitySchema>;
const limitation = z.enum([
  "missing_case",
  "missing_authorization",
  "missing_adapter",
  "synthetic_only",
  "identity_drift",
  "case_failed",
  "safety_stop",
  "operator_required",
  "measurement_unavailable",
]);
export const caseResultSchema = z
  .object({
    case_id: z.enum(caseIds),
    run_id: z.string().uuid(),
    deployment_version_id: z.string().uuid(),
    manifest_sha256: hash,
    worker_build: hash,
    companion_build: hash.nullable(),
    native_build: hash.nullable(),
    client_version: z
      .string()
      .regex(/^[A-Za-z0-9_.+-]{1,64}$/)
      .nullable(),
    result: z.enum(["pass", "fail", "not_run"]),
    started_at: z.number().int(),
    finished_at: z.number().int(),
    attempts: z.number().int().min(0).max(100),
    artifact_sha256: hash.nullable(),
    limitation: limitation.nullable(),
  })
  .strict()
  .refine(
    (r) =>
      r.finished_at >= r.started_at &&
      (r.result !== "pass" || (r.artifact_sha256 !== null && r.attempts > 0 && r.limitation === null)),
  );
export type CaseResult = z.infer<typeof caseResultSchema>;
export type CaseOutcome = Pick<CaseResult, "result" | "attempts" | "artifact_sha256" | "limitation"> & {
  client_version?: string | null;
};
export interface TestCase {
  id: (typeof caseIds)[number];
  requiresLive: boolean;
  run(identity: Readonly<RunIdentity>): Promise<CaseOutcome>;
}
export interface RunPort {
  verify(identity: Readonly<RunIdentity>): Promise<void>;
  write(result: CaseResult): Promise<void>;
}
export const runReportSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["live", "synthetic"]),
    identity: runIdentitySchema,
    results: z.array(caseResultSchema).length(caseIds.length),
    exitCode: z.union([z.literal(0), z.literal(1)]),
  })
  .strict();
export async function runCases(
  input: RunIdentity,
  mode: "live" | "synthetic",
  cases: TestCase[],
  port: RunPort,
): Promise<z.infer<typeof runReportSchema>> {
  const identity = Object.freeze(runIdentitySchema.parse(input));
  if (new Set(cases.map((c) => c.id)).size !== cases.length || cases.some((c) => !caseIds.includes(c.id)))
    throw new Error("case selection refused");
  const results: CaseResult[] = [];
  let stopped = false;
  for (const id of caseIds) {
    const selected = cases.find((c) => c.id === id);
    const started = Date.now();
    let outcome: CaseOutcome = {
      result: "not_run",
      attempts: 0,
      artifact_sha256: null,
      limitation: stopped ? "safety_stop" : !selected ? "missing_case" : "synthetic_only",
    };
    if (!stopped && selected && !(mode === "synthetic" && selected.requiresLive)) {
      let stage: "verify" | "case" = "verify";
      try {
        await port.verify(identity);
        stage = "case";
        outcome = await selected.run(identity);
        stage = "verify";
        await port.verify(identity);
      } catch {
        outcome = {
          result: "fail",
          attempts: stage === "case" ? 1 : outcome.attempts,
          artifact_sha256: null,
          limitation: stage === "case" ? "case_failed" : "identity_drift",
        };
        stopped = true;
      }
    }
    let result: CaseResult;
    try {
      result = caseResultSchema.parse({
        case_id: id,
        run_id: identity.runId,
        deployment_version_id: identity.deploymentVersionId,
        manifest_sha256: identity.manifestSha256,
        worker_build: identity.workerBuildId,
        companion_build: identity.companionBuildId ?? null,
        native_build: identity.nativeBuildId ?? null,
        client_version: outcome.client_version ?? null,
        result: outcome.result,
        started_at: started,
        finished_at: Math.max(started, Date.now()),
        attempts: outcome.attempts,
        artifact_sha256: outcome.artifact_sha256,
        limitation: outcome.limitation,
      });
    } catch {
      stopped = true;
      result = {
        case_id: id,
        run_id: identity.runId,
        deployment_version_id: identity.deploymentVersionId,
        manifest_sha256: identity.manifestSha256,
        worker_build: identity.workerBuildId,
        companion_build: identity.companionBuildId ?? null,
        native_build: identity.nativeBuildId ?? null,
        client_version: null,
        result: "fail",
        started_at: started,
        finished_at: Math.max(started, Date.now()),
        attempts: 0,
        artifact_sha256: null,
        limitation: "case_failed",
      };
    }
    if (result.result === "fail") stopped = true;
    await port.write(result);
    results.push(result);
  }
  return runReportSchema.parse({
    version: 1,
    mode,
    identity,
    results,
    exitCode: results.every((r) => r.result === "pass") ? 0 : 1,
  });
}
