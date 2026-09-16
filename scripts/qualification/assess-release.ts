import { z } from "zod";
import { canonicalize } from "../../worker/src/crypto/canonical.ts";
import { ArtifactRef, CaseReport, CommonCases, Mode, ModeEvidence, Target, type PrivateSink } from "./contracts.ts";
import { EvidenceVerifier } from "./contracts-validation.ts";

const Input = z
  .object({
    version: z.literal(2),
    target: Target,
    modes: z.array(z.object({ mode: Mode, evidence: ArtifactRef }).strict()).max(2),
    components: z.array(z.object({ caseId: z.enum(CommonCases), report: ArtifactRef }).strict()).max(9),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.modes.map((m) => m.mode)).size === v.modes.length &&
      new Set(v.components.map((c) => c.caseId)).size === v.components.length,
  );

/** Evidence assessment is read-only. Implementation readiness is code-owned, never a manifest assertion. */
export async function assessRelease(input: unknown, sink: PrivateSink) {
  const blockers: string[] = ["implementation_incomplete"];
  const parsed = Input.safeParse(input);
  if (!parsed.success)
    return {
      implementation: "not_run",
      qualification: "fail",
      release: "fail",
      verifiedModes: 0,
      verifiedComponents: 0,
      blockers: [...blockers, "invalid_manifest"],
    } as const;
  const manifest = parsed.data;
  const verifier = new EvidenceVerifier();
  let verifiedComponents = 0;
  let verifiedModes = 0;
  let invalid = false;
  for (const caseId of CommonCases) {
    const component = manifest.components.find((c) => c.caseId === caseId);
    if (!component) {
      blockers.push(`missing_component:${caseId}`);
      continue;
    }
    try {
      const report = CaseReport.parse(await sink.read(component.report));
      if (
        report.caseId !== caseId ||
        report.identity.purpose !== "release-component" ||
        canonicalize(report.identity.target) !== canonicalize(manifest.target)
      )
        throw new Error("invalid_evidence");
      await verifier.validateCase(report, sink, report.identity);
      verifiedComponents++;
    } catch {
      invalid = true;
      blockers.push(`invalid_component:${caseId}`);
    }
  }
  const runs = new Set<string>();
  const epochs = new Set<string>();
  for (const mode of Mode.options) {
    const entry = manifest.modes.find((m) => m.mode === mode);
    if (!entry) {
      blockers.push(`missing_mode:${mode}`);
      continue;
    }
    try {
      const evidence = ModeEvidence.parse(await sink.read(entry.evidence));
      const identity = evidence.identity;
      if (identity.mode !== mode || canonicalize(identity.target) !== canonicalize(manifest.target))
        throw new Error("invalid_evidence");
      for (const component of evidence.components) {
        const supplied = manifest.components.find((c) => c.caseId === component.caseId);
        if (!supplied || canonicalize(supplied.report) !== canonicalize(component.report))
          throw new Error("invalid_evidence");
      }
      await verifier.validateModeEvidence(evidence, sink, identity);
      if (identity.qualificationEpoch === null || runs.has(identity.runId) || epochs.has(identity.qualificationEpoch))
        throw new Error("invalid_evidence");
      runs.add(identity.runId);
      epochs.add(identity.qualificationEpoch);
      verifiedModes++;
    } catch {
      invalid = true;
      blockers.push(`invalid_mode:${mode}`);
    }
  }
  const qualification = invalid
    ? "fail"
    : verifiedModes === 2 && verifiedComponents === CommonCases.length
      ? "pass"
      : "not_run";
  return {
    implementation: "not_run",
    qualification,
    release: invalid ? "fail" : "not_run",
    verifiedModes,
    verifiedComponents,
    blockers,
  } as const;
}
