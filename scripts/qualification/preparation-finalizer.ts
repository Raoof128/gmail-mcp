import { canonicalize } from "../../worker/src/crypto/canonical.ts";
import {
  ArtifactRef,
  Authorization,
  ControllerResult,
  PreparationIdentity,
  PreparationSource,
  RunIdentity,
  Time,
  identityHash,
  preparationRoot,
  type PrivateSink,
  type VerifiedControllerContext,
} from "./contracts.ts";
import { PreparationClosure, QualificationSource, deriveCaseVerdict } from "./contracts-validation.ts";
import { digest } from "./private-files.ts";
import { EMPTY_SLOT_JOURNAL_ROOT, type DurableIntentStore } from "./intent-store.ts";
import type { PreparationFinalizer } from "./case-adapter.ts";

async function publish(sink: PrivateSink, prefix: string, value: unknown): Promise<ArtifactRef> {
  const sha256 = digest(JSON.stringify(value) + "\n");
  const ref = { name: `${prefix}-${sha256}.json`, sha256 };
  try {
    return await sink.write(ref.name, value);
  } catch {
    // A restart may find the exact publication left before a crash or directory sync error.
    if (canonicalize(await sink.read(ref)) !== canonicalize(value)) throw new Error("invalid_evidence");
    return ref;
  }
}
/** Component observations already have a fixed run identity before their preparation closes. */
export class DurableComponentFinalizer implements PreparationFinalizer {
  private readonly authorizationRef: ArtifactRef;
  constructor(
    private readonly journal: DurableIntentStore,
    authorization: ArtifactRef,
  ) {
    this.authorizationRef = ArtifactRef.parse(authorization);
  }
  async close(context: VerifiedControllerContext, input: ControllerResult): Promise<ArtifactRef> {
    const prep = PreparationIdentity.parse(context.preparation);
    const auth = Authorization.parse(context.authorization);
    const identity = RunIdentity.parse(context.identity);
    const result = ControllerResult.parse(input);
    const now = Time.parse(context.now());
    const commitment = identityHash("preparation-commitment", { identity: prep, intentRefs: [] }, canonicalize);
    if (prep.purpose !== "release-component" || prep.allocations.some((a) => a.slots.length > 0))
      throw new Error("mutation_journal_unavailable");
    if (
      now < prep.createdAt ||
      now < identity.startedAt ||
      identity.purpose !== prep.purpose ||
      identity.mode !== prep.mode ||
      canonicalize(prep.target) !== canonicalize(identity.target) ||
      canonicalize(await context.sink.read(this.authorizationRef)) !== canonicalize(auth) ||
      auth.targetHash !== identityHash("target", prep.target, canonicalize) ||
      prep.authorizationSha256 !== identityHash("authorization", auth, canonicalize) ||
      prep.expiresAt > auth.expiresAt ||
      commitment !== identity.preparationCommitment ||
      commitment !== context.preparationCommitment ||
      this.journal.binding.authorizationId !== auth.authorizationId ||
      this.journal.binding.preparationCommitment !== commitment
    )
      throw new Error("preparation binding mismatch");
    const caseId = prep.allocations[0]!.caseId;
    if (prep.allocations.some((a) => a.caseId !== caseId)) throw new Error("preparation_incomplete");
    const allPass = result.limitation === null && deriveCaseVerdict(caseId, result.observations) === "pass";
    const outcomes = [];
    const sourceRefs = [];
    for (const allocation of prep.allocations) {
      let sealed = await this.journal.readSample(allocation.sampleId);
      if (!sealed) {
        const rows = result.observations.filter((o) => o.sampleId === allocation.sampleId);
        const row = rows.length === 1 ? rows[0]! : null;
        let ready = allPass && row !== null && now < prep.expiresAt;
        let reason: PreparationSource["reason"] = result.limitation ?? "preparation_incomplete";
        if (now >= prep.expiresAt) reason = "intent_expired";
        if (row) {
          try {
            if (
              row.identitySha256 !== identityHash("run", identity, canonicalize) ||
              row.details.caseId !== allocation.caseId ||
              row.recordedAt < identity.startedAt ||
              row.recordedAt > now ||
              row.recordedAt >= prep.expiresAt
            )
              throw new Error("invalid_evidence");
            const source = QualificationSource.parse(
              await context.sink.read({ name: `source-${row.sourceSha256}.json`, sha256: row.sourceSha256 }),
            );
            const { sourceSha256: _hash, ...projection } = row;
            if (
              canonicalize(source.observation) !== canonicalize(projection) ||
              source.sampleId !== row.sampleId ||
              source.identitySha256 !== row.identitySha256 ||
              source.recordedAt !== row.recordedAt
            )
              throw new Error("invalid_evidence");
          } catch {
            ready = false;
            reason = "invalid_evidence";
          }
        }
        const sealedAt = Time.parse(context.now());
        if (sealedAt < now) throw new Error("identity_drift");
        if (sealedAt >= prep.expiresAt) {
          ready = false;
          reason = "intent_expired";
        }
        const source = PreparationSource.parse({
          version: 2,
          preparationCommitment: commitment,
          sampleId: allocation.sampleId,
          producer: "operator",
          event: ready ? "component-ready" : rows.length === 0 ? "sample-not-run" : "sample-failed",
          recordedAt: sealedAt,
          operationId: null,
          bindingSha256: null,
          slotJournalRoot: EMPTY_SLOT_JOURNAL_ROOT,
          observationSourceSha256: row?.sourceSha256 ?? null,
          intendedBarrierReached: false,
          reason: ready ? null : reason,
        });
        sealed = await this.journal.sealSample(source);
      }
      sourceRefs.push(await publish(context.sink, "preparation-source", sealed.source));
      outcomes.push(sealed.outcome);
    }
    // The closed set includes every allocation, including omitted and interrupted samples.
    preparationRoot(prep, outcomes, auth, canonicalize);
    return publish(
      context.sink,
      "preparation-closure",
      PreparationClosure.parse({
        version: 2,
        identity: prep,
        authorization: this.authorizationRef,
        intentRefs: [],
        outcomes,
        sourceRefs,
      }),
    );
  }
}
type PreparationSource = ReturnType<typeof PreparationSource.parse>;
