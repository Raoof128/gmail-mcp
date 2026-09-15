import { z } from "zod";
import { canonicalize } from "../../worker/src/crypto/canonical.ts";
import {
  ArtifactRef,
  Authorization,
  CaseReport,
  ControllerResult,
  Observation,
  PreparationIdentity,
  Reason,
  RunIdentity,
  preparationRoot,
  identityHash,
  type CaseAdapter,
  type CaseId,
  type Controller,
  type VerifiedControllerContext,
} from "./contracts.ts";
import { EvidenceVerifier, PreparationClosure, deriveCaseVerdict } from "./contracts-validation.ts";
import { selectRunCase } from "./run-v2.ts";
/** Close every allocated outcome durably, preserving a first failure. No controller gets this authority. */
export interface PreparationFinalizer {
  close(context: VerifiedControllerContext, result: ControllerResult): Promise<ArtifactRef>;
}
export class SourceCaseAdapter implements CaseAdapter {
  constructor(private readonly finalizer: PreparationFinalizer) {}
  async run(context: VerifiedControllerContext, caseId: CaseId, controller: Controller): Promise<CaseReport> {
    const identity = RunIdentity.parse(context.identity);
    const preparation = PreparationIdentity.parse(context.preparation);
    const authorization = Authorization.parse(context.authorization);
    selectRunCase(identity, [caseId]);
    if (preparation.purpose !== identity.purpose || preparation.mode !== identity.mode)
      throw new Error("identity_drift");
    const freeze = <T>(value: T): T => {
      if (value !== null && typeof value === "object") {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
      return value;
    };
    const stableContext = Object.freeze({
      ...context,
      identity: freeze(identity),
      preparation: freeze(preparation),
      authorization: freeze(authorization),
      sink: Object.freeze({ read: context.sink.read.bind(context.sink), write: context.sink.write.bind(context.sink) }),
      intents: Object.freeze({
        consume: context.intents.consume.bind(context.intents),
        appendOutcome: context.intents.appendOutcome.bind(context.intents),
      }),
    });
    const checkTarget = async () => {
      await stableContext.verifyTarget();
      const now = stableContext.now();
      if (
        !Number.isSafeInteger(now) ||
        now < identity.startedAt ||
        now >= Math.min(preparation.expiresAt, authorization.expiresAt, identity.probeExpiresAt ?? Infinity)
      )
        throw new Error("identity_drift");
    };
    if (
      preparation.allocations.some((a) => a.caseId !== caseId) ||
      canonicalize(preparation.target) !== canonicalize(identity.target) ||
      preparation.authorizationSha256 !== identityHash("authorization", authorization, canonicalize) ||
      context.preparationCommitment !== identity.preparationCommitment
    )
      throw new Error("identity_drift");
    let result: ControllerResult = { observations: [], limitation: null };
    let stage: "verify" | "controller" = "verify";
    let failed = false;
    try {
      await checkTarget();
      stage = "controller";
      result = ControllerResult.parse(await controller(stableContext));
      stage = "verify";
      await checkTarget();
      if (
        canonicalize(context.identity) !== canonicalize(identity) ||
        canonicalize(context.preparation) !== canonicalize(preparation) ||
        canonicalize(context.authorization) !== canonicalize(authorization)
      )
        throw new Error("identity_drift");
    } catch {
      failed = true;
      result = { observations: result.observations, limitation: stage === "verify" ? "identity_drift" : "case_failed" };
    }
    if (result.observations.some((o) => Object.values(o.safety).some((count) => count !== 0))) {
      failed = true;
      result.limitation = "case_failed";
    }
    if (
      result.limitation !== null &&
      ["case_failed", "safety_stop", "invalid_evidence", "identity_drift"].includes(result.limitation)
    )
      failed = true;
    const observationRefs: ArtifactRef[] = [];
    const seen = new Set<string>();
    for (const raw of result.observations) {
      const row = Observation.parse(raw);
      if (
        seen.has(row.sampleId) ||
        !preparation.allocations.some((a) => a.sampleId === row.sampleId) ||
        row.identitySha256 !== identityHash("run", identity, canonicalize) ||
        row.details.caseId !== caseId
      ) {
        failed = true;
        result.limitation = "invalid_evidence";
      }
      seen.add(row.sampleId);
      // Index preserves a malformed duplicate attempt as evidence without replacing its first row.
      observationRefs.push(
        await stableContext.sink.write(`observation-${identity.runId}-${observationRefs.length}.json`, row),
      );
    }
    // A failed finalizer is a failed command, never a fabricated closure or passing report.
    const closureRef = ArtifactRef.parse(await this.finalizer.close(stableContext, result));
    const closure = PreparationClosure.parse(await stableContext.sink.read(closureRef));
    if (canonicalize(closure.identity) !== canonicalize(preparation)) throw new Error("preparation_incomplete");
    const root = preparationRoot(preparation, closure.outcomes, authorization, canonicalize);
    let verdict: "pass" | "fail" | "not_run" = failed
      ? "fail"
      : result.limitation !== null
        ? "not_run"
        : deriveCaseVerdict(caseId, result.observations);
    let limitation: z.infer<typeof Reason> | null = result.limitation ?? (verdict === "pass" ? null : "case_failed");
    const candidate = () =>
      CaseReport.parse({
        version: 2,
        caseId,
        identity,
        preparationRoot: root,
        preparationClosure: closureRef,
        result: verdict,
        limitation,
        attempts: result.observations.length,
        observationRefs,
      });
    if (verdict === "pass") {
      try {
        await new EvidenceVerifier().validateCase(candidate(), stableContext.sink, identity);
      } catch {
        verdict = "fail";
        limitation = "invalid_evidence";
      }
    }
    return candidate();
  }
}
