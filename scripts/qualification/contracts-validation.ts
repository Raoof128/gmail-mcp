import { z } from "zod";
import { canonicalize } from "../../worker/src/crypto/canonical.ts";
import {
  ArtifactRef,
  Authorization,
  CaseReport,
  CommonCases,
  IntentTemplate,
  ModeEvidence,
  Observation,
  PreparationIdentity,
  PreparationOutcome,
  PreparationSource,
  RunIdentity,
  assertModeReports,
  assertReady,
  identityHash,
  preparationRoot,
  requiredProof,
  type CaseId,
  type PrivateSink,
  type Verdict,
} from "./contracts.ts";

const exact = <T>(values: T[], expected: T[]) =>
  values.length === expected.length &&
  new Set(values).size === values.length &&
  expected.every((v) => values.includes(v));

/** Derive case truth from validated individual rows; source provenance is checked separately below. */
export function deriveCaseVerdict(caseId: CaseId, input: Observation[]): Verdict {
  const rows = z.array(Observation).max(128).parse(input);
  if (
    !rows.length ||
    new Set(rows.map((o) => o.sampleId)).size !== rows.length ||
    rows.some((o) => o.details.caseId !== caseId || Object.values(o.safety).some((n) => n !== 0))
  )
    return "fail";
  const details = rows.map((o) => o.details);
  const live = rows.every((o) => o.surface === "live");
  const device = rows.every((o) => o.surface === "device");
  let pass = false;
  switch (caseId) {
    case "generated-id":
      pass =
        live &&
        rows.length === 3 &&
        details.every((d) => d.caseId === "generated-id" && d.exactMatch && d.replaySame && d.executedAudits === 1) &&
        new Set(details.map((d) => (d.caseId === "generated-id" ? d.operationId : ""))).size === 3;
      break;
    case "session-status":
      pass =
        live &&
        rows.length === 3 &&
        details.every((d) => d.caseId === "session-status" && d.finalReceipt && d.executedAudits === 1) &&
        new Set(details.map((d) => (d.caseId === "session-status" ? d.operationId : ""))).size === 3;
      break;
    case "draft-negative":
      pass =
        exact(
          details.map((d) => (d.caseId === "draft-negative" ? d.variant : "")),
          ["reused-id", "reused-thread", "reused-both", "old-draft-live"],
        ) &&
        rows.every(
          (o) =>
            o.details.caseId === "draft-negative" &&
            o.details.automaticConfirmations === 0 &&
            o.surface === (o.details.variant === "old-draft-live" ? "live" : "synthetic"),
        );
      break;
    case "byte-round-trip":
      pass =
        live &&
        rows.length === 6 &&
        details.filter((d) => d.caseId === "byte-round-trip" && d.attachmentBytes === 0).length === 3 &&
        details.filter((d) => d.caseId === "byte-round-trip" && d.attachmentBytes === 26214400).length === 3 &&
        details.every(
          (d) =>
            d.caseId === "byte-round-trip" && d.inputSha256 === d.outputSha256 && d.receivedBytes === d.attachmentBytes,
        );
      break;
    case "media-boundary":
      pass =
        rows.every((o) => o.surface === "synthetic") &&
        rows.length === 6 &&
        details.filter((d) => d.caseId === "media-boundary" && d.mimeBytes === 5242880).length === 3 &&
        details.every(
          (d) =>
            d.caseId === "media-boundary" &&
            d.externalMutations === 1 &&
            d.transport === (d.mimeBytes === 5242880 ? "media" : "resumable"),
        );
      break;
    case "reply-revoke":
      pass =
        live &&
        rows.length === 4 &&
        details.filter((d) => d.caseId === "reply-revoke" && d.step === "reply" && d.threadMatches).length === 3 &&
        details.filter((d) => d.caseId === "reply-revoke" && d.step === "revoke" && d.revoked && d.subsequentUseRefused)
          .length === 1;
      break;
    case "installed-clients": {
      const expected = [
        "remote:code",
        "remote:desktop",
        "remote:claude-ai",
        "companion:code",
        "companion:desktop",
      ].flatMap((c) => ["allow", "ask", "timeout"].map((f) => `${c}:${f}`));
      pass =
        rows.every((o) => o.surface === "installed-client") &&
        exact(
          details.map((d) => (d.caseId === "installed-clients" ? `${d.component}:${d.client}:${d.flow}` : "")),
          expected,
        ) &&
        details.every((d) => d.caseId === "installed-clients" && d.correctResult && d.singleSend && d.cleanProjection);
      break;
    }
    case "native":
      pass =
        device &&
        exact(
          details.map((d) => (d.caseId === "native" ? `${d.step}:${d.ordinal}` : "")),
          [...[1, 2, 3].map((n) => `login-cycle:${n}`), ...Array.from({ length: 10 }, (_, i) => `kill-point:${i + 1}`)],
        ) &&
        details.every(
          (d) =>
            d.caseId === "native" &&
            d.receiptMatches &&
            d.staleEpochUses === 0 &&
            (d.step !== "login-cycle" || (d.realKeychain && d.realBrowser)),
        );
      break;
    case "physical-durability":
      pass =
        device &&
        exact(
          details.map((d) => (d.caseId === "physical-durability" ? d.trial : 0)),
          [1, 2, 3],
        ) &&
        details.some((d) => d.caseId === "physical-durability" && d.acknowledgedBeforeLoss) &&
        details.some((d) => d.caseId === "physical-durability" && !d.acknowledgedBeforeLoss) &&
        details.every(
          (d) =>
            d.caseId === "physical-durability" &&
            d.physicalLoss &&
            !d.uncertainAcknowledged &&
            (!d.acknowledgedBeforeLoss || d.recoveredDigestMatches),
        );
      break;
    case "resources":
      pass =
        live &&
        exact(
          details.map((d) => (d.caseId === "resources" ? `${d.step}:${d.ordinal}` : "")),
          [...Array.from({ length: 10 }, (_, i) => `serial:${i + 1}`), "concurrent:1"],
        ) &&
        details.every(
          (d) =>
            d.caseId === "resources" &&
            d.coverageComplete &&
            d.peakMemoryBytes < 128000000 &&
            d.cpuMs < d.routeCpuLimitMs &&
            d.requestBytes === d.mimeBytes &&
            d.responseBytes === d.attachmentBytes &&
            (d.step === "serial" ? d.concurrentStreams <= 1 : d.concurrentStreams === 2),
        );
      break;
    case "rollback":
      pass =
        exact(
          details.map((d) => (d.caseId === "rollback" ? d.step : "")),
          ["writer-corpus", "epoch-recreate", "maintenance", "direct-winner", "deployment-floor"],
        ) &&
        rows.every(
          (o) =>
            o.details.caseId === "rollback" &&
            o.details.passed &&
            o.surface === (o.details.step === "deployment-floor" ? "platform" : "synthetic") &&
            (o.details.step !== "writer-corpus" || (o.details.expectedSites === 136 && o.details.coveredSites === 136)),
        );
      break;
  }
  return pass ? "pass" : "fail";
}

export const QualificationSource = z
  .object({
    version: z.literal(2),
    producer: z.enum([
      "worker",
      "google-controller",
      "native-helper",
      "installed-client-operator",
      "power-operator",
      "platform-controller",
    ]),
    identitySha256: RunIdentity.shape.manifestSha256,
    sampleId: z.string().uuid(),
    recordedAt: z.number().int().nonnegative(),
    observation: Observation.omit({ sourceSha256: true }),
  })
  .strict();
export const PreparationClosure = z
  .object({
    version: z.literal(2),
    identity: PreparationIdentity,
    authorization: ArtifactRef,
    intentRefs: z.array(ArtifactRef).max(64),
    outcomes: z.array(PreparationOutcome).max(128),
    sourceRefs: z.array(ArtifactRef).max(128),
  })
  .strict();

function assertEqual(a: unknown, b: unknown): void {
  if (canonicalize(a) !== canonicalize(b)) throw new Error("invalid_evidence");
}
function producerMatches(source: z.infer<typeof QualificationSource>): boolean {
  const o = source.observation;
  if (o.details.caseId === "physical-durability") return source.producer === "power-operator" && o.surface === "device";
  if (o.details.caseId === "native") return source.producer === "native-helper" && o.surface === "device";
  if (o.details.caseId === "installed-clients")
    return source.producer === "installed-client-operator" && o.surface === "installed-client";
  if (o.details.caseId === "resources" || o.details.caseId === "rollback")
    return source.producer === "platform-controller";
  return source.producer === "worker" || source.producer === "google-controller";
}

/** The sink verifies exact file hashes/permissions before this verifier accepts parsed records. */
export class EvidenceVerifier {
  async validateCase(input: unknown, sink: PrivateSink, expectedIdentity: RunIdentity): Promise<CaseReport> {
    const report = CaseReport.parse(input);
    const identity = RunIdentity.parse(expectedIdentity);
    assertEqual(report.identity, identity);
    if (report.result !== "pass") throw new Error("case_failed");
    const closure = PreparationClosure.parse(await sink.read(report.preparationClosure));
    const auth = Authorization.parse(await sink.read(closure.authorization));
    const prep = closure.identity;
    const capabilities: Partial<Record<CaseId, z.infer<typeof Authorization>["capabilities"]>> = {
      "generated-id": ["send"],
      "session-status": ["send"],
      "draft-negative": ["send"],
      "byte-round-trip": ["send", "download"],
      "reply-revoke": ["send", "revoke"],
      "installed-clients": ["send"],
      native: ["native-session"],
      "physical-durability": ["power-loss"],
      resources: ["send", "download"],
    };
    if (
      (capabilities[report.caseId] ?? []).some((c) => !auth.capabilities.includes(c)) ||
      identity.startedAt < prep.createdAt ||
      identity.startedAt >= prep.expiresAt
    )
      throw new Error("missing_authorization");
    assertEqual(prep.target, identity.target);
    if (prep.purpose !== identity.purpose || prep.mode !== identity.mode) throw new Error("identity_drift");
    const root = preparationRoot(prep, closure.outcomes, auth, canonicalize);
    if (root !== report.preparationRoot || (identity.purpose === "recovery-mode" && root !== identity.preparationRoot))
      throw new Error("preparation_incomplete");
    if (
      identity.preparationCommitment !==
      identityHash("preparation-commitment", { identity: prep, intentRefs: closure.intentRefs }, canonicalize)
    )
      throw new Error("preparation_incomplete");
    const slots = prep.allocations.flatMap((a) => a.slots.map((s) => ({ sampleId: a.sampleId, ...s })));
    if (slots.length !== closure.intentRefs.length) throw new Error("preparation_incomplete");
    for (const [index, ref] of closure.intentRefs.entries()) {
      const intent = IntentTemplate.parse(await sink.read(ref));
      const slot = slots[index]!;
      if (
        intent.slotId !== slot.slotId ||
        intent.sampleId !== slot.sampleId ||
        intent.capability !== slot.capability ||
        intent.declaredBytes > slot.maxBodyBytes ||
        intent.allocationHash !== identityHash("preparation", prep, canonicalize)
      )
        throw new Error("preparation_incomplete");
    }
    if (
      prep.allocations.some((a) => a.caseId !== report.caseId) ||
      report.attempts !== prep.allocations.length ||
      report.observationRefs.length !== report.attempts ||
      closure.sourceRefs.length !== report.attempts ||
      closure.outcomes.some((o) => o.state !== "ready")
    )
      throw new Error("preparation_incomplete");
    if (identity.purpose === "recovery-mode") {
      assertReady(closure.outcomes);
      if (prep.allocations.some((a) => !a.slots.some((s) => s.capability === "send")))
        throw new Error("preparation_incomplete");
    }
    // Slot persistence exists, but its source-graph resolver is not wired yet. A hash alone cannot prove consumption.
    if (slots.length > 0) throw new Error("mutation_journal_unavailable");
    const observations: Observation[] = [];
    for (const [index, ref] of report.observationRefs.entries()) {
      const row = Observation.parse(await sink.read(ref));
      const outcome = closure.outcomes[index]!;
      const allocation = prep.allocations[index]!;
      const prepRef = closure.sourceRefs[index]!;
      const prepared = PreparationSource.parse(await sink.read(prepRef));
      if (
        row.sampleId !== allocation.sampleId ||
        outcome.sampleId !== row.sampleId ||
        row.identitySha256 !== identityHash("run", identity, canonicalize) ||
        row.details.caseId !== report.caseId ||
        row.recordedAt < identity.startedAt ||
        row.recordedAt >= prep.expiresAt ||
        (identity.probeExpiresAt !== null && row.recordedAt >= identity.probeExpiresAt)
      )
        throw new Error("identity_drift");
      if (
        prepared.sampleId !== row.sampleId ||
        prepared.preparationCommitment !== identity.preparationCommitment ||
        outcome.sourceSha256 !== prepRef.sha256 ||
        prepared.recordedAt !== outcome.recordedAt ||
        prepared.operationId !== outcome.operationId ||
        prepared.bindingSha256 !== outcome.bindingSha256
      )
        throw new Error("preparation_incomplete");
      if (identity.purpose === "recovery-mode") {
        if (
          prepared.event !== "barrier-ready" ||
          outcome.recordedAt > identity.startedAt ||
          (row.details.caseId !== "generated-id" && row.details.caseId !== "session-status") ||
          row.details.operationId !== outcome.operationId
        )
          throw new Error("preparation_incomplete");
      } else if (
        prepared.event !== "component-ready" ||
        prepared.observationSourceSha256 !== row.sourceSha256 ||
        prepared.recordedAt < row.recordedAt
      )
        throw new Error("preparation_incomplete");
      // Source names are fixed by the writer; the expected SHA always comes from the committed row.
      const source = QualificationSource.parse(
        await sink.read({ name: `source-${row.sourceSha256}.json`, sha256: row.sourceSha256 }),
      );
      const { sourceSha256: _source, ...projection } = row;
      assertEqual(source.observation, projection);
      if (
        source.identitySha256 !== row.identitySha256 ||
        source.sampleId !== row.sampleId ||
        source.recordedAt !== row.recordedAt ||
        !producerMatches(source)
      )
        throw new Error("invalid_evidence");
      if (row.details.caseId === "reply-revoke") {
        if (
          auth.sacrificialAccountId === null ||
          auth.sacrificialCredentialVersion === null ||
          row.details.sacrificialTargetHash !==
            identityHash(
              "target",
              {
                ...prep.target,
                accountId: auth.sacrificialAccountId,
                credentialVersion: auth.sacrificialCredentialVersion,
              },
              canonicalize,
            )
        )
          throw new Error("invalid_evidence");
        // Consumed-slot provenance is mandatory; Task 4 supplies the durable journal resolver.
        throw new Error("mutation_journal_unavailable");
      }
      // These cases require platform/measurement provenance beyond a self-authored source row.
      if (row.details.caseId === "resources" || row.details.caseId === "rollback")
        throw new Error("measurement_or_corpus_verifier_unavailable");
      observations.push(row);
    }
    if (deriveCaseVerdict(report.caseId, observations) !== "pass") throw new Error("case_failed");
    return report;
  }
  async validateModeEvidence(input: unknown, sink: PrivateSink, expectedIdentity: RunIdentity): Promise<ModeEvidence> {
    const evidence = ModeEvidence.parse(input);
    assertEqual(evidence.identity, RunIdentity.parse(expectedIdentity));
    const proof = await this.validateCase(await sink.read(evidence.proof), sink, expectedIdentity);
    if (proof.caseId !== requiredProof(expectedIdentity.mode!)) throw new Error("invalid_evidence");
    const components: CaseReport[] = [];
    for (const ref of evidence.components) {
      if (!CommonCases.includes(ref.caseId)) throw new Error("invalid_evidence");
      const parsed = CaseReport.parse(await sink.read(ref.report));
      components.push(await this.validateCase(parsed, sink, parsed.identity));
    }
    assertModeReports(evidence, proof, components, expectedIdentity, canonicalize);
    return evidence;
  }
}
