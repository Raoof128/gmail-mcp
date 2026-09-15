# Plan 6 revision 3 contracts

Normative planning appendix. This revises the Plan 6 draft, not the running Worker. The TypeScript below is an executable reference for data contracts and pure planning checks. Copy it into the named implementation modules only when Plan 6 implementation is approved. Existing version-1 evidence remains historical and cannot enable version-2 qualification.

## 1. Required evidence and trust boundary (F02, F06)

A mode run has exactly one recovery proof case. `generated_search` requires three generated-ID search proofs/replays; `send_session_status` requires three bound final session receipts. Session-mode metadata inspection never counts as search recovery. Status before search describes Worker selection when both controls exist; a qualification run neither changes its frozen mode nor borrows the other mode's proof. Isolate the other mode's control from the fixture IDs while qualifying, and prove each selected lease has the intended mode.

Both modes additionally require all nine common components below before enablement. This preserves the inherited mandatory safety gates. Correcting mixed evidence surfaces does not waive native, physical or resource acceptance. A component run starts before its observations: its RunIdentity has the pre-execution preparationCommitment and a null preparationRoot; its final CaseReport carries the closed root. A mode run starts after its all-ready fixture preparation: RunIdentity requires both commitment and closed root. Neither identity changes after its run starts. A component run has no qualification epoch and cannot enable recovery by itself. A release requires the two separately qualified mode runs and the common components. Run/report selection uses these matrices, not the old unconditional eleven-case loop.

| Scope                           | Required cases                                                                                                                     | Binding                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| generated_search proof          | generated-id                                                                                                                       | Exact target, account/grant, mode and probe epoch; 3 distinct samples                |
| send_session_status proof       | session-status                                                                                                                     | Exact target, account/grant, mode and probe epoch; 3 distinct samples                |
| Common enable and release gates | draft-negative, byte-round-trip, media-boundary, reply-revoke, installed-clients, native, physical-durability, resources, rollback | Exact deployment/config/schema/tool/component snapshot; complete per-sample evidence |

Common components bind `snapshotHash`, defined below. Each component also records its own complete run identity whose target equals the mode target; different run UUID/purpose/epoch-free lifecycle remains explicit. Reply/revoke uses the sacrificial account and grant declared in the committed authorization for that component; that exception never changes the mode account or supplies its proof. Other account-bearing components use the target account. Local-only samples retain the same code/component snapshot but are labeled synthetic/device, never live. A change to any snapshot field requires fresh matching components. A mode account/grant change requires new mode qualification and matching common run target bindings; no account-bearing observation transfers across grants.

Every pass derives from typed observations and verified private source files. Hashes establish byte identity, not truth of an operator statement. Provider/platform observations must come from the verified transport; native observations from the named helper; installed-client and power observations are explicitly operator-supervised and reference the committed sample schedule. Do not accept arbitrary imported aggregate counters or a caller-supplied verdict. The trusted operator/platform can falsify their own observations; this format does not claim cryptographic proof against those authorities.

## 2. Canonical identity and bounded schemas (F03, F06)

Use existing RFC 8785 `canonicalize` and SHA-256. Hash input bytes are UTF-8 of `gmail-mcp/plan6/v2/<domain>\n` followed by canonical JSON. Object keys canonicalize; ordered allocations and journal events keep their order. Domains never substitute for one another. Artifact hashes separately cover exact persisted bytes including their trailing newline. The reference accepts canonicalize as an injected dependency to keep planning fixtures outside production imports; implementation supplies `worker/src/crypto/canonical.ts`.

All artifact JSON is <=65,536 UTF-8 bytes, strict and finite. At most 128 samples per preparation/report, 64 fixture mutations and 2,348,810,240 outgoing fixture-body bytes per authorization. These are operator-tool bounds, not changes to Worker quotas. Each allocated mutation has a unique precommitted slot and full declared body ceiling <=36,700,160. Charge that full ceiling before invoking a remote mutation; ambiguous calls remain charged. Metadata reads/status polling do not consume mutation slots but retain Worker recovery budgets. Staging upload, send, ACK and revoke are separate mutation slots when used. An operator can authorize smaller limits; allocations cannot exceed them.

```ts
import { z } from "zod";
import { createHash } from "node:crypto";

export const CaseIds = [
  "generated-id",
  "session-status",
  "draft-negative",
  "byte-round-trip",
  "media-boundary",
  "reply-revoke",
  "installed-clients",
  "native",
  "physical-durability",
  "resources",
  "rollback",
] as const;
export type CaseId = (typeof CaseIds)[number];
export const CommonCases = [
  "draft-negative",
  "byte-round-trip",
  "media-boundary",
  "reply-revoke",
  "installed-clients",
  "native",
  "physical-durability",
  "resources",
  "rollback",
] as const;
export const Reason = z.enum([
  "missing_case",
  "missing_authorization",
  "missing_adapter",
  "synthetic_only",
  "identity_drift",
  "case_failed",
  "safety_stop",
  "operator_required",
  "measurement_unavailable",
  "provider_barrier_unavailable",
  "quiescence_unavailable",
  "deployment_exclusion_unavailable",
  "intent_expired",
  "preparation_incomplete",
  "ambiguous_mutation",
  "invalid_evidence",
]);
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const Time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const Mode = z.enum(["generated_search", "send_session_status"]);
export type RecoveryMode = z.infer<typeof Mode>;
export const Verdict = z.enum(["pass", "fail", "not_run"]);
export type Verdict = z.infer<typeof Verdict>;
const Epoch = z.string().regex(/^qe_[A-Za-z0-9_-]{43}$/);
const Origin = z
  .string()
  .url()
  .refine((s) => new URL(s).protocol === "https:" && new URL(s).origin === s);
export const Snapshot = z
  .object({
    origin: Origin,
    platformAccountId: z.string().regex(/^[a-f0-9]{32}$/),
    workerName: Id,
    databaseId: z.string().uuid(),
    deploymentId: z.string().uuid(),
    deploymentVersionId: z.string().uuid(),
    workerBuildId: Hash,
    qualificationBuildId: Hash,
    companionBuildId: Hash,
    nativeBuildId: Hash,
    configSha256: Hash,
    schemaSha256: Hash,
    restoreGeneration: Id,
    profile: z.enum(["normal", "scratch"]),
    compatibilityVersion: z.literal(3),
  })
  .strict();
export const Target = Snapshot.extend({
  userId: Id,
  accountId: Id,
  credentialVersion: z.number().int().nonnegative(),
}).strict();
export type Target = z.infer<typeof Target>;
export const Authorization = z
  .object({
    version: z.literal(2),
    authorizationId: z.string().uuid(),
    targetHash: Hash,
    sender: z.string().email(),
    recipient: z.string().email(),
    expiresAt: Time,
    capabilities: z
      .array(
        z.enum([
          "send",
          "revoke",
          "power-loss",
          "deploy",
          "restore",
          "staging",
          "enable",
          "download",
          "native-session",
        ]),
      )
      .max(9),
    maxMutations: z.number().int().min(0).max(64),
    maxWriteBytes: z.number().int().min(0).max(2348810240),
    sacrificialAccountId: Id.nullable(),
    sacrificialCredentialVersion: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .refine(
    (a) =>
      new Set(a.capabilities).size === a.capabilities.length &&
      (a.sacrificialAccountId === null) === (a.sacrificialCredentialVersion === null),
  );
export const MutationSlot = z
  .object({
    slotId: z.string().uuid(),
    capability: z.enum(["send", "revoke", "staging", "download", "native-session"]),
    maxBodyBytes: z.number().int().min(0).max(36700160),
  })
  .strict();
export const Allocation = z
  .object({ sampleId: z.string().uuid(), caseId: z.enum(CaseIds), slots: z.array(MutationSlot).max(8) })
  .strict();
export const PreparationIdentity = z
  .object({
    version: z.literal(2),
    preparationId: z.string().uuid(),
    target: Target,
    authorizationSha256: Hash,
    purpose: z.enum(["recovery-mode", "release-component"]),
    mode: Mode.nullable(),
    createdAt: Time,
    expiresAt: Time,
    allocations: z.array(Allocation).min(1).max(128),
  })
  .strict()
  .refine(
    (p) =>
      p.createdAt < p.expiresAt &&
      (p.purpose === "recovery-mode") === (p.mode !== null) &&
      new Set(p.allocations.map((a) => a.sampleId)).size === p.allocations.length,
  );
export type PreparationIdentity = z.infer<typeof PreparationIdentity>;
export const PreparationOutcome = z
  .object({
    sampleId: z.string().uuid(),
    state: z.enum(["ready", "failed", "uncertain", "not_run"]),
    operationId: Id.nullable(),
    bindingSha256: Hash.nullable(),
    sourceSha256: Hash,
    recordedAt: Time,
    reason: Reason.nullable(),
  })
  .strict()
  .refine((o) => (o.state === "ready" ? o.reason === null : o.reason !== null));
export type PreparationOutcome = z.infer<typeof PreparationOutcome>;
export const PreparationSource = z
  .object({
    version: z.literal(2),
    preparationCommitment: Hash,
    sampleId: z.string().uuid(),
    producer: z.enum(["google-controller", "worker", "native-helper", "operator"]),
    event: z.enum(["barrier-ready", "component-ready", "sample-failed", "sample-uncertain", "sample-not-run"]),
    recordedAt: Time,
    operationId: Id.nullable(),
    bindingSha256: Hash.nullable(),
    slotJournalRoot: Hash,
    observationSourceSha256: Hash.nullable(),
    intendedBarrierReached: z.boolean(),
    reason: Reason.nullable(),
  })
  .strict()
  .refine((s) =>
    s.event === "barrier-ready"
      ? s.intendedBarrierReached &&
        s.reason === null &&
        s.operationId !== null &&
        s.bindingSha256 !== null &&
        s.observationSourceSha256 === null
      : s.event === "component-ready"
        ? !s.intendedBarrierReached &&
          s.reason === null &&
          s.observationSourceSha256 !== null &&
          (s.operationId === null) === (s.bindingSha256 === null)
        : s.reason !== null,
  );
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(65536),
    z.array(JsonValueSchema).max(128),
    z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), JsonValueSchema),
  ]),
);
export const ArgumentReference = z
  .object({
    targetPath: z
      .array(z.union([z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.number().int().min(0).max(127)]))
      .min(1)
      .max(4),
    sourceSampleId: z.string().uuid(),
    sourceSlotId: z.string().uuid(),
    field: z.enum(["handle", "download_id", "action_id", "message_id", "thread_id", "operation_id"]),
  })
  .strict()
  .refine((r) =>
    ["attachments", "handle", "download_id", "action_id", "message_id", "thread_id", "operation_id"].includes(
      String(r.targetPath[0]),
    ),
  );
export const IntentTemplate = z
  .object({
    version: z.literal(2),
    allocationHash: Hash,
    sampleId: z.string().uuid(),
    slotId: z.string().uuid(),
    capability: z.enum(["send", "revoke", "staging", "download", "native-session"]),
    tool: Id,
    targetScope: z.enum(["primary", "sacrificial"]),
    literals: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), JsonValueSchema),
    references: z.array(ArgumentReference).max(8),
    idempotencyKey: z.string().min(1).max(128),
    declaredBytes: z.number().int().min(0).max(36700160),
  })
  .strict();
export const ResolvedIntent = z
  .object({
    version: z.literal(2),
    preparationCommitment: Hash,
    templateSha256: Hash,
    sampleId: z.string().uuid(),
    slotId: z.string().uuid(),
    argumentSha256: Hash,
    sourceResultHashes: z.array(Hash).max(8),
    recordedAt: Time,
  })
  .strict();
export const RunIdentity = z
  .object({
    version: z.literal(2),
    runId: z.string().uuid(),
    purpose: z.enum(["recovery-mode", "release-component"]),
    target: Target,
    preparationCommitment: Hash,
    preparationRoot: Hash.nullable(),
    manifestSha256: Hash,
    mode: Mode.nullable(),
    qualificationEpoch: Epoch.nullable(),
    probeExpiresAt: Time.nullable(),
    startedAt: Time,
  })
  .strict()
  .refine((r) =>
    r.purpose === "recovery-mode"
      ? r.preparationRoot !== null &&
        r.mode !== null &&
        r.qualificationEpoch !== null &&
        r.probeExpiresAt !== null &&
        r.startedAt < r.probeExpiresAt
      : r.preparationRoot === null && r.mode === null && r.qualificationEpoch === null && r.probeExpiresAt === null,
  );
export type RunIdentity = z.infer<typeof RunIdentity>;
const Count = z.number().int().min(0).max(4096);
const Safety = z
  .object({
    duplicates: Count,
    falseConfirmations: Count,
    unexpectedRecipients: Count,
    credentialLeaks: Count,
    overwrites: Count,
    resourceErrors: Count,
  })
  .strict();
const Surface = z.enum(["synthetic", "live", "installed-client", "device", "platform"]);
const Details = z.discriminatedUnion("caseId", [
  z
    .object({
      caseId: z.literal("generated-id"),
      proofKind: z.literal("generated_search"),
      operationId: Id,
      resultSha256: Hash,
      exactMatch: z.boolean(),
      replaySame: z.boolean(),
      executedAudits: Count,
    })
    .strict(),
  z
    .object({
      caseId: z.literal("session-status"),
      proofKind: z.literal("session_receipt"),
      operationId: Id,
      resultSha256: Hash,
      mimeBytes: z.number().int().min(5242881).max(36700160),
      finalReceipt: z.boolean(),
      executedAudits: Count,
    })
    .strict(),
  z
    .object({
      caseId: z.literal("draft-negative"),
      variant: z.enum(["reused-id", "reused-thread", "reused-both", "old-draft-live"]),
      automaticConfirmations: Count,
      observationSha256: Hash,
    })
    .strict(),
  z
    .object({
      caseId: z.literal("byte-round-trip"),
      attachmentBytes: z.union([z.literal(0), z.literal(26214400)]),
      mimeBytes: z.number().int().min(0).max(36700160),
      inputSha256: Hash,
      outputSha256: Hash,
      receivedBytes: z.number().int().min(0).max(26214400),
    })
    .strict(),
  z
    .object({
      caseId: z.literal("media-boundary"),
      mimeBytes: z.union([z.literal(5242880), z.literal(5242881)]),
      transport: z.enum(["media", "resumable"]),
      externalMutations: Count,
    })
    .strict(),
  z
    .object({
      caseId: z.literal("reply-revoke"),
      step: z.enum(["reply", "revoke"]),
      threadMatches: z.boolean(),
      revoked: z.boolean(),
      subsequentUseRefused: z.boolean(),
      sacrificialTargetHash: Hash,
      resolvedIntentSha256: Hash,
    })
    .strict(),
  z
    .object({
      caseId: z.literal("installed-clients"),
      client: z.enum(["code", "desktop", "claude-ai"]),
      clientVersion: z.string().regex(/^[A-Za-z0-9_.+-]{1,64}$/),
      flow: z.enum(["allow", "ask", "timeout"]),
      component: z.enum(["remote", "companion"]),
      correctResult: z.boolean(),
      singleSend: z.boolean(),
      cleanProjection: z.boolean(),
    })
    .strict(),
  z
    .object({
      caseId: z.literal("native"),
      step: z.enum(["login-cycle", "kill-point"]),
      ordinal: z.number().int().min(1).max(10),
      hostSha256: Hash,
      realKeychain: z.boolean(),
      realBrowser: z.boolean(),
      staleEpochUses: Count,
      receiptMatches: z.boolean(),
    })
    .strict(),
  z
    .object({
      caseId: z.literal("physical-durability"),
      trial: z.number().int().min(1).max(3),
      deviceSha256: Hash,
      physicalLoss: z.boolean(),
      acknowledgedBeforeLoss: z.boolean(),
      recoveredDigestMatches: z.boolean(),
      uncertainAcknowledged: z.boolean(),
    })
    .strict(),
  z
    .object({
      caseId: z.literal("resources"),
      step: z.enum(["serial", "concurrent"]),
      ordinal: z.number().int().min(1).max(10),
      requestBytes: Time,
      responseBytes: Time,
      fixtureSha256: Hash,
      attachmentBytes: z.literal(26214400),
      mimeBytes: z.number().int().min(26214400).max(36700160),
      concurrentStreams: z.number().int().min(0).max(2),
      peakMemoryBytes: z.number().finite().nonnegative(),
      cpuMs: z.number().finite().nonnegative(),
      routeCpuLimitMs: z.number().finite().positive(),
      measurementSourceSha256: Hash,
      coverageComplete: z.boolean(),
    })
    .strict(),
  z
    .object({
      caseId: z.literal("rollback"),
      step: z.enum(["writer-corpus", "epoch-recreate", "maintenance", "direct-winner", "deployment-floor"]),
      expectedSites: Count,
      coveredSites: Count,
      passed: z.boolean(),
      compatibilityVersion: z.literal(3),
    })
    .strict(),
]);
export const Observation = z
  .object({
    version: z.literal(2),
    sampleId: z.string().uuid(),
    identitySha256: Hash,
    sourceSha256: Hash,
    surface: Surface,
    recordedAt: Time,
    safety: Safety,
    details: Details,
  })
  .strict();
export type Observation = z.infer<typeof Observation>;
export const ControllerResult = z
  .object({
    observations: z.array(Observation).max(128),
    limitation: Reason.nullable(),
  })
  .strict();
export type ControllerResult = z.infer<typeof ControllerResult>;
export const ArtifactRef = z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,120}\.json$/), sha256: Hash }).strict();
export type ArtifactRef = z.infer<typeof ArtifactRef>;
export const CaseReport = z
  .object({
    version: z.literal(2),
    caseId: z.enum(CaseIds),
    identity: RunIdentity,
    preparationRoot: Hash,
    result: Verdict,
    limitation: Reason.nullable(),
    attempts: z.number().int().min(0).max(128),
    observationRefs: z.array(ArtifactRef).max(128),
  })
  .strict()
  .refine((r) =>
    r.result === "pass"
      ? r.limitation === null && r.attempts > 0 && r.observationRefs.length > 0
      : r.limitation !== null,
  );
export type CaseReport = z.infer<typeof CaseReport>;
const ManifestBase = z.object({
  version: z.literal(2),
  target: Target,
  authorization: ArtifactRef,
  privateDirectory: z.string().min(1).max(4096),
  deploymentReceipt: ArtifactRef,
  resultName: z.string().regex(/^[A-Za-z0-9_-]{1,120}\.json$/),
  deploymentExclusionEvidence: ArtifactRef,
});
const PreparedFields = { preparation: ArtifactRef, preparationCommitment: Hash };
const ModeFields = {
  purpose: z.literal("recovery-mode"),
  mode: Mode,
  caseIds: z.array(z.enum(["generated-id", "session-status"])).length(1),
};
const ProbeFields = {
  ...PreparedFields,
  preparationRoot: Hash,
  transition: ArtifactRef,
  expectedEpoch: Epoch,
  probeIds: z.array(Id).length(3),
};
const ComponentFields = {
  purpose: z.literal("release-component"),
  caseIds: z.array(z.enum(CommonCases)).length(1),
  ...PreparedFields,
};
export const RecoveryPrepareManifest = ManifestBase.extend({
  ...ModeFields,
  ...PreparedFields,
  phase: z.literal("prepare"),
}).strict();
export const RecoveryProbeManifest = ManifestBase.extend({
  ...ModeFields,
  ...ProbeFields,
  expectedEpoch: Epoch.nullable(),
  phase: z.literal("probe"),
}).strict();
export const RecoveryRunManifest = ManifestBase.extend({
  ...ModeFields,
  ...ProbeFields,
  phase: z.literal("run"),
}).strict();
export const RecoveryEnableManifest = ManifestBase.extend({
  ...ModeFields,
  ...ProbeFields,
  phase: z.literal("enable"),
  modeEvidence: ArtifactRef,
}).strict();
export const RecoveryDisableManifest = ManifestBase.extend({
  purpose: z.literal("recovery-mode"),
  mode: Mode,
  phase: z.literal("disable"),
  expectedEpoch: Epoch,
}).strict();
export const ComponentPrepareManifest = ManifestBase.extend({
  ...ComponentFields,
  phase: z.literal("prepare"),
}).strict();
export const ComponentRunManifest = ManifestBase.extend({ ...ComponentFields, phase: z.literal("run") }).strict();
export const ManifestV2 = z
  .union([
    z.discriminatedUnion("phase", [
      RecoveryPrepareManifest,
      RecoveryProbeManifest,
      RecoveryRunManifest,
      RecoveryEnableManifest,
      RecoveryDisableManifest,
    ]),
    z.discriminatedUnion("phase", [ComponentPrepareManifest, ComponentRunManifest]),
  ])
  .refine(
    (m) =>
      (!("probeIds" in m) || new Set(m.probeIds).size === 3) &&
      (m.purpose !== "recovery-mode" || !("caseIds" in m) || m.caseIds[0] === requiredProof(m.mode)),
  );
export const ComponentRef = z.object({ caseId: z.enum(CommonCases), snapshotHash: Hash, report: ArtifactRef }).strict();
export const ModeEvidence = z
  .object({
    version: z.literal(2),
    purpose: z.literal("recovery-mode"),
    identity: RunIdentity,
    proof: ArtifactRef,
    components: z.array(ComponentRef).length(9),
  })
  .strict()
  .refine((e) => e.identity.purpose === "recovery-mode" && new Set(e.components.map((c) => c.caseId)).size === 9);
export type ModeEvidence = z.infer<typeof ModeEvidence>;
export const RestoreTarget = z
  .object({
    version: z.literal(2),
    snapshot: Snapshot,
    databaseId: z.string().uuid(),
    bookmark: z.string().regex(/^[A-Za-z0-9:_-]{1,256}$/),
    authorizationSha256: Hash,
    authorizationExpiresAt: Time,
    generation: Id,
    routedVersionsSha256: Hash,
  })
  .strict()
  .refine((r) => r.databaseId === r.snapshot.databaseId && r.generation === r.snapshot.restoreGeneration);
export type RestoreTarget = z.infer<typeof RestoreTarget>;
export const QuiescenceRecord = z
  .object({
    databaseId: z.string().uuid(),
    generation: Id,
    routedVersionsSha256: Hash,
    mechanismId: Id,
    issuerEvidenceSha256: Hash,
    verifiedAt: Time,
    validUntil: Time,
  })
  .strict()
  .refine((p) => p.verifiedAt < p.validUntil);
export type VerifiedQuiescence = z.infer<typeof QuiescenceRecord> & { readonly __verified: unique symbol };
export type Canonicalize = (value: unknown) => string;
export type Domain =
  | "snapshot"
  | "target"
  | "authorization"
  | "preparation"
  | "preparation-commitment"
  | "preparation-root"
  | "transition"
  | "run"
  | "writer-site";
export function identityHash(domain: Domain, value: unknown, canonicalize: Canonicalize): string {
  return createHash("sha256").update(`gmail-mcp/plan6/v2/${domain}\n`).update(canonicalize(value)).digest("hex");
}
export function snapshotOf(target: Target): z.infer<typeof Snapshot> {
  const { userId: _u, accountId: _a, credentialVersion: _g, ...snapshot } = target;
  return Snapshot.parse(snapshot);
}
export function requiredProof(mode: RecoveryMode): "generated-id" | "session-status" {
  return mode === "generated_search" ? "generated-id" : "session-status";
}
export function probeExpiry(now: number, intentExpiresAt: number): number {
  Time.parse(now);
  Time.parse(intentExpiresAt);
  if (intentExpiresAt <= now) throw new Error("intent_expired");
  return Math.min(now + 604800000, intentExpiresAt);
}
export function preparationRoot(
  input: unknown,
  outcomesInput: unknown,
  authorizationInput: unknown,
  canonicalize: Canonicalize,
): string {
  const p = PreparationIdentity.parse(input);
  const a = Authorization.parse(authorizationInput);
  const outcomes = z.array(PreparationOutcome).max(128).parse(outcomesInput);
  if (
    a.targetHash !== identityHash("target", p.target, canonicalize) ||
    p.authorizationSha256 !== identityHash("authorization", a, canonicalize) ||
    p.expiresAt > a.expiresAt
  )
    throw new Error("invalid_evidence");
  const slots = p.allocations.flatMap((s) => s.slots);
  if (
    slots.length > a.maxMutations ||
    new Set(slots.map((s) => s.slotId)).size !== slots.length ||
    slots.reduce((n, s) => n + s.maxBodyBytes, 0) > a.maxWriteBytes ||
    slots.some((s) => !a.capabilities.includes(s.capability))
  )
    throw new Error("invalid_evidence");
  if (outcomes.length !== p.allocations.length || new Set(outcomes.map((o) => o.sampleId)).size !== outcomes.length)
    throw new Error("preparation_incomplete");
  const ordered = p.allocations.map((allocation) => {
    const o = outcomes.find((v) => v.sampleId === allocation.sampleId);
    if (!o || o.recordedAt < p.createdAt || (o.state === "ready" && o.recordedAt >= p.expiresAt))
      throw new Error("preparation_incomplete");
    return o;
  });
  return identityHash("preparation-root", { preparation: p, outcomes: ordered }, canonicalize);
}
export function assertReady(outcomes: PreparationOutcome[]): void {
  if (
    !outcomes.length ||
    outcomes.some((o) => o.state !== "ready" || o.operationId === null || o.bindingSha256 === null) ||
    new Set(outcomes.map((o) => o.operationId)).size !== outcomes.length
  )
    throw new Error("preparation_incomplete");
}
export function assertWriterSites(expected: string[], actual: string[]): void {
  if (JSON.stringify([...expected].sort()) !== JSON.stringify([...actual].sort()))
    throw new Error("writer site coverage differs");
}
export function parsePrivateArtifact(bytes: Uint8Array): unknown {
  if (bytes.byteLength > 65536) throw new Error("artifact_too_large");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  function bound(v: unknown, depth: number): void {
    if (depth > 8) throw new Error("artifact_too_deep");
    if (Array.isArray(v)) {
      if (v.length > 128) throw new Error("artifact_array_too_large");
      for (const item of v) bound(item, depth + 1);
    } else if (v !== null && typeof v === "object") {
      if (Object.keys(v).length > 64) throw new Error("artifact_too_many_keys");
      for (const item of Object.values(v)) bound(item, depth + 1);
    }
  }
  bound(value, 0);
  return value;
}
export interface ComponentSteps {
  commitPreparation(): Promise<void>;
  startIdentityWithNullRoot(): Promise<void>;
  observe(): Promise<void>;
  persistObservationSource(): Promise<void>;
  persistComponentReadySource(): Promise<void>;
  closeOutcomes(): Promise<void>;
  emitReport(): Promise<void>;
  sealInterrupted(reason: unknown): Promise<void>;
}
export async function runComponentSequence(steps: ComponentSteps): Promise<void> {
  await steps.commitPreparation();
  try {
    await steps.startIdentityWithNullRoot();
    await steps.observe();
    await steps.persistObservationSource();
    await steps.persistComponentReadySource();
    await steps.closeOutcomes();
    await steps.emitReport();
  } catch (error) {
    await steps.sealInterrupted(error);
    throw error;
  }
}
export interface PrivateSink {
  write(name: string, value: unknown): Promise<ArtifactRef>;
  read(ref: ArtifactRef): Promise<unknown>;
}
export const Consumption = z
  .object({
    authorizationId: z.string().uuid(),
    preparationCommitment: Hash,
    sampleId: z.string().uuid(),
    slotId: z.string().uuid(),
    resolvedIntentSha256: Hash,
    templateSha256: Hash,
    argumentSha256: Hash,
    declaredBytes: z.number().int().min(0).max(36700160),
  })
  .strict();
export type Consumption = z.infer<typeof Consumption>;
export type ConsumptionResult =
  { status: "new"; committed: Consumption } | { status: "already-consumed"; committed: Consumption };
export function assertSameConsumption(expected: Consumption, actual: Consumption, canonicalize: Canonicalize): void {
  if (canonicalize(Consumption.parse(expected)) !== canonicalize(Consumption.parse(actual)))
    throw new Error("ambiguous_mutation");
}
export interface IntentStore {
  consume(request: Consumption): Promise<ConsumptionResult>;
  appendOutcome(preparationHash: string, outcome: PreparationOutcome): Promise<ArtifactRef>;
}
export const MutationTools = z.enum([
  "send_message",
  "reply",
  "forward",
  "send_draft",
  "create_draft",
  "update_draft",
  "staging_upload",
  "ack_download",
  "revoke_account",
  "native_stage",
  "native_save",
  "native_login",
  "native_logout",
]);
export type MutationTool = z.infer<typeof MutationTools>;
export const ToolCapability = {
  send_message: "send",
  reply: "send",
  forward: "send",
  send_draft: "send",
  create_draft: "send",
  update_draft: "send",
  staging_upload: "staging",
  ack_download: "download",
  revoke_account: "revoke",
  native_stage: "staging",
  native_save: "download",
  native_login: "native-session",
  native_logout: "native-session",
} as const;
export const MutationProjection = z
  .object({
    tool: MutationTools,
    target: Target,
    sender: z.string().email().nullable(),
    to: z.array(z.string().email()).max(1),
    cc: z.array(z.string().email()).max(0),
    bcc: z.array(z.string().email()).max(0),
    argumentSha256: Hash,
    requestBytes: z.number().int().min(0).max(36700160),
  })
  .strict();
export function validateResolvedMutation(
  authorizationInput: unknown,
  preparationInput: unknown,
  slotInput: unknown,
  templateInput: unknown,
  resolvedInput: unknown,
  projectionInput: unknown,
  preparationCommitment: string,
  now: number,
  canonicalize: Canonicalize,
): void {
  const a = Authorization.parse(authorizationInput);
  const p = PreparationIdentity.parse(preparationInput);
  const slot = MutationSlot.parse(slotInput);
  const t = IntentTemplate.parse(templateInput);
  const r = ResolvedIntent.parse(resolvedInput);
  const m = MutationProjection.parse(projectionInput);
  const capability = ToolCapability[m.tool];
  Time.parse(now);
  const allocation = p.allocations.find((v) => v.sampleId === t.sampleId);
  const allocatedSlot = allocation?.slots.find((v) => v.slotId === slot.slotId);
  if (
    !allocatedSlot ||
    canonicalize(allocatedSlot) !== canonicalize(slot) ||
    p.authorizationSha256 !== identityHash("authorization", a, canonicalize) ||
    a.targetHash !== identityHash("target", p.target, canonicalize) ||
    t.allocationHash !== identityHash("preparation", p, canonicalize) ||
    r.preparationCommitment !== Hash.parse(preparationCommitment) ||
    r.templateSha256 !== createHash("sha256").update(canonicalize(t)).digest("hex") ||
    t.sampleId !== r.sampleId ||
    t.slotId !== r.slotId ||
    t.slotId !== slot.slotId ||
    t.tool !== m.tool ||
    slot.capability !== capability ||
    t.capability !== capability ||
    !a.capabilities.includes(capability) ||
    now < p.createdAt ||
    now >= Math.min(a.expiresAt, p.expiresAt) ||
    r.recordedAt < p.createdAt ||
    r.recordedAt > now ||
    m.argumentSha256 !== r.argumentSha256 ||
    m.requestBytes !== t.declaredBytes ||
    m.requestBytes > slot.maxBodyBytes
  )
    throw new Error("invalid_evidence");
  if (
    (p.purpose === "recovery-mode" && t.targetScope === "sacrificial") ||
    (m.tool === "revoke_account" && t.targetScope !== "sacrificial") ||
    (t.targetScope === "sacrificial" && m.tool !== "reply" && m.tool !== "revoke_account")
  )
    throw new Error("invalid_evidence");
  const expectedTarget =
    t.targetScope === "sacrificial"
      ? { ...p.target, accountId: a.sacrificialAccountId, credentialVersion: a.sacrificialCredentialVersion }
      : p.target;
  if (canonicalize(m.target) !== canonicalize(expectedTarget)) throw new Error("identity_drift");
  if (capability === "send") {
    if (m.sender !== a.sender || m.to.length !== 1 || m.to[0] !== a.recipient) throw new Error("missing_authorization");
  } else if (m.sender !== null || m.to.length !== 0) throw new Error("invalid_evidence");
}
export type MutationAdmission = Consumption & { readonly __admittedMutation: unique symbol };
export interface PreparationContext {
  preparation: PreparationIdentity;
  preparationCommitment: string;
  authorization: z.infer<typeof Authorization>;
  sink: PrivateSink;
  intents: IntentStore;
  now(): number;
  monotonicNow(): number;
  verifyTarget(): Promise<void>;
  admitMutation(input: { sampleId: string; slotId: string; resolvedIntent: ArtifactRef }): Promise<MutationAdmission>;
  workerObserve(
    sampleId: string,
    tool: "get_message" | "get_thread" | "search_threads",
    args: Record<string, unknown>,
  ): Promise<unknown>;
  workerMutate(
    admission: MutationAdmission,
    tool: Exclude<MutationTool, `native_${string}`>,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  nativeObserve(sampleId: string, command: "receipt" | "status", args: Record<string, unknown>): Promise<unknown>;
  nativeMutate(
    admission: MutationAdmission,
    command: "native_login" | "native_logout" | "native_stage" | "native_save",
    args: Record<string, unknown>,
  ): Promise<unknown>;
}
export interface VerifiedControllerContext extends PreparationContext {
  identity: RunIdentity;
}
export type PreparationController = (context: PreparationContext) => Promise<PreparationOutcome[]>;
export type Controller = (context: VerifiedControllerContext) => Promise<ControllerResult>;
export function assertModeReports(
  evidenceInput: unknown,
  proofInput: unknown,
  componentsInput: unknown,
  expectedIdentity: RunIdentity,
  canonicalize: Canonicalize,
): ModeEvidence {
  const e = ModeEvidence.parse(evidenceInput);
  const proof = CaseReport.parse(proofInput);
  const components = z.array(CaseReport).length(9).parse(componentsInput);
  const runHash = identityHash("run", expectedIdentity, canonicalize);
  if (
    expectedIdentity.purpose !== "recovery-mode" ||
    expectedIdentity.mode === null ||
    identityHash("run", e.identity, canonicalize) !== runHash ||
    identityHash("run", proof.identity, canonicalize) !== runHash ||
    proof.caseId !== requiredProof(expectedIdentity.mode) ||
    proof.result !== "pass" ||
    proof.attempts !== 3 ||
    proof.observationRefs.length !== 3
  )
    throw new Error("invalid_evidence");
  const snapshotHash = identityHash("snapshot", snapshotOf(expectedIdentity.target), canonicalize);
  for (const caseId of CommonCases) {
    const rows = components.filter((r) => r.caseId === caseId);
    const reference = e.components.find((r) => r.caseId === caseId);
    if (
      rows.length !== 1 ||
      rows[0]!.result !== "pass" ||
      rows[0]!.identity.purpose !== "release-component" ||
      !reference ||
      reference.snapshotHash !== snapshotHash ||
      identityHash("target", rows[0]!.identity.target, canonicalize) !==
        identityHash("target", expectedIdentity.target, canonicalize) ||
      identityHash("snapshot", snapshotOf(rows[0]!.identity.target), canonicalize) !== snapshotHash
    )
      throw new Error("invalid_evidence");
  }
  return e;
}
export interface EvidenceVerifier {
  validateModeEvidence(input: unknown, sink: PrivateSink, expectedIdentity: RunIdentity): Promise<ModeEvidence>;
}
export interface CaseAdapter {
  run(context: VerifiedControllerContext, caseId: CaseId, controller: Controller): Promise<CaseReport>;
}
export interface RestoreController {
  prepare(target: RestoreTarget): Promise<ArtifactRef>;
  restore(target: RestoreTarget): Promise<{ state: "quarantined"; generation: string }>;
}
export interface QuiescenceVerifier {
  verify(target: RestoreTarget): Promise<VerifiedQuiescence>;
}
```

## 3. Verdicts, sources and adapters

All controllers, including provider and resource controllers, return ControllerResult. No controller returns a trusted pass flag or the version-1 CaseOutcome. `cases/types.ts` adapts them through `CaseAdapter.run`. The adapter parses ControllerResult, checks identity and allocation membership, resolves every source through PrivateSink.read, validates the source-specific record against the observation, derives the verdict below, writes observations and returns a CaseReport. `run.ts`, `cli.ts`, `evidence.ts`, `artifacts.ts` and case imports migrate together. No cast from version 2 to version 1.

An unavailable mechanism returns `{observations: [], limitation: "provider_barrier_unavailable"}` (or the matching enum value). The adapter preserves not_run. Malformed evidence, identity drift, a missing allocated result after activity, duplicate source/sample substitution or any nonzero safety counter yields fail with a finite reason. A pass requires all allocated samples, no limitation, zero safety counters and the following exact coverage; failures preserve existing observations rather than erasing them.

| Case                | Exact coverage and pass predicate                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| generated-id        | 3 live distinct operations; proofKind generated_search; exactMatch, replaySame true, executedAudits=1; intended Worker loss reached for each prepared fixture                                                                                    |
| session-status      | 3 live distinct operations; proofKind session_receipt; finalReceipt true, executedAudits=1, MIME >5 MiB; intended Worker loss reached                                                                                                            |
| draft-negative      | One each reused-id/reused-thread/reused-both synthetic and old-draft-live live; automaticConfirmations=0                                                                                                                                         |
| byte-round-trip     | 3 per size 0 and 26214400; live; input/output hash equal and receivedBytes=attachmentBytes; MIME <=36700160                                                                                                                                      |
| media-boundary      | 3 per size 5242880 and 5242881; synthetic; media for first, resumable for second; externalMutations=1                                                                                                                                            |
| reply-revoke        | 3 live reply rows with threadMatches=true, then one live revoke row with revoked/subsequentUseRefused=true; committed sacrificial account; no grant substitution into mode run                                                                   |
| installed-clients   | 15 rows: remote allow/ask/timeout for code/desktop/claude-ai (9), companion allow/ask/timeout for code/desktop (6); installed-client surface; correctResult/singleSend/cleanProjection=true; exact committed versions                            |
| native              | Login ordinals 1–3 with realKeychain/realBrowser=true; kill-point ordinals 1–10; device surface; receiptMatches=true, staleEpochUses=0                                                                                                           |
| physical-durability | Device trials 1–3; physicalLoss=true; at least one acknowledged and one uncertain trial; all acknowledged rows recoveredDigestMatches=true, every row uncertainAcknowledged=false                                                                |
| resources           | Live serial ordinals 1–10 with verified 26,214,400-byte attachment fixture; one live concurrent ordinal 1 with concurrentStreams=2; coverageComplete=true; peakMemoryBytes<128000000 and cpuMs<routeCpuLimitMs from verified source, zero errors |
| rollback            | One each writer-corpus/epoch-recreate/maintenance/direct-winner synthetic and deployment-floor platform; passed=true; corpus expectedSites=coveredSites=136 with the site-key multiset proof; all compatibilityVersion=3                         |

Qualification source records have exactly `{version:2, producer, identitySha256, sampleId, recordedAt, observation}` where producer is `worker`, `google-controller`, `native-helper`, `installed-client-operator`, `power-operator` or `platform-controller`, and observation is the same bounded Observation data with `sourceSha256` omitted. This avoids a self-hash. The sink stores its bytes, computes their SHA, then the observation references that SHA. Adapter compares all shared fields and independently checks producer/surface/case compatibility. Source schema uses `Observation.omit({sourceSha256:true})`, not an arbitrary JSON blob. PrivateSink.read resolves only the expected same-directory basename, refuses symlinks/unsafe permissions, verifies exact file SHA before parsing, and applies the 65,536-byte cap. A supplied hash without a matching source fails.

CaseReport refs point to observation files. ModeEvidence.proof points to a passing CaseReport with requiredProof(identity.mode), matching identity and exactly three distinct prepared operations. Each of its nine components resolves to a passing CaseReport and matches the declared snapshotHash, computed from `snapshotOf(target)`. All component case IDs are required exactly once. `assertModeReports` checks the parsed report identities/matrix after source validation; it is not a file verifier. `validateModeEvidence(input, sink, expectedIdentity)` resolves and verifies the whole graph; schema parsing alone cannot enable. Compare complete canonical identity hashes, not caller-chosen hash strings. The enable transaction still asserts the exact current probe epoch and expiry before rotating to a fresh enabled epoch.

Snapshot includes the qualification tooling digest so altered verifiers cannot silently reuse evidence. Task 9 computes it over tracked `scripts/qualification/` production files, root/shared package and lock/config inputs; excludes tests and documents. Companion/native digests cover their production source, build manifests/lockfiles and compiled artifact digest, with canonical path ordering and clean-input refusal. Each digest recipe is versioned in its build receipt and verified against the invoked binaries; no arbitrary supplied digest is authoritative.

Preparation uses PreparationController with PreparationContext; it does not require or fabricate a future RunIdentity. PreparationSource uses barrier-ready for mode fixtures and component-ready for local/live component completion. Component-ready references the completed observation source hash; that observation binds the already fixed component RunIdentity with a null closure root. It requires no invented operation or provider barrier. PreparationSource contains the known pre-execution commitment, slot journal root, barrier outcome and operation binding, with no final-run hash or self-hash. Store it first; PreparationOutcome.sourceSha256 references those exact bytes. Mode preparationRoot therefore cannot depend on a future Observation or RunIdentity. After a verified probe transition the CLI constructs VerifiedControllerContext for qualification controllers. Component controllers start with their epoch-free RunIdentity and null closure root; their final CaseReport carries the post-run closure root. Add a dependency-graph test rejecting a source that refers to its own final root.

ManifestV2 is the private CLI envelope, not an authority token. Private preflight verifies every referenced input and its relationship to target/purpose/phase before credentials. Probe phase requires a complete all-ready preparation, intended transition and exact IDs; recovery-mode run/enable require the verified transition receipt; component runs have no transition receipt. Prepare phase has no expected epoch or probe IDs; disable is a separate explicit target control edit and never produces qualifying evidence. Native/component runs still verify deployment exclusion before any external action. Synthetic-only planning tests bypass remote execution entirely, never by creating forged exclusion evidence.

## 4. Preparation and restart protocol (F03)

Publish the complete PreparationIdentity and authorization before credentials or fixture mutation. Mode preparations allocate exactly the relevant three proof samples; component preparations allocate the exact table coverage. Precommit each mutation as IntentTemplate: literals bind recipients/sender and known arguments; references bind a server-created handle or ID to a specific earlier sample/slot response. These templates, UUIDs, idempotency keys and body ceilings are immutable. A reference may target only the listed non-recipient fields, never sender/To/CC/BCC, credentials or an arbitrary URL. Tool/action names are validated against the controller's fixed shared-schema allowlist, not merely the Id grammar.

Build a dependency DAG before execution. A reference must name an earlier declared slot in this same preparation; reject forward references, cycles, duplicate target paths and any replacement of an existing literal. Verify source response ownership, sample/slot, target and hash before resolving. Resolve exactly the declared field, validate the final arguments against the existing tool schema, and exclusively publish ResolvedIntent before consuming that slot. The actual request arguments must match its argumentSha256. Persist only allowed ID projections of source results, never signed URLs or credentials. Staging transport secrets stay in the verified adapter's private memory. After a crash, a resolved-but-unconsumed slot may proceed once if all authority still holds; a consumed slot never retries its mutation. A changed handle, source response, literal recipient or template is a mismatch, not a new attempt. Slot consumption is keyed independently of output directory and records the resolved intent hash. ACK uses this dependency mechanism for the handle returned by download/staging.

First compute allocationHash as `identityHash("preparation", identity, canonicalize)`; intent templates reference this hash, avoiding a self-reference. The pre-execution commitment is `identityHash("preparation-commitment", {identity, intentRefs}, canonicalize)` with template refs in allocation/slot order and a verified ref for every slot. Enforce a bounded file read of at most 65,536 bytes before fatal UTF-8 decoding, JSON parsing, depth <=8 and <=64 keys per object checks, then recursive schema validation; oversized template bodies fail before credentials, even when a tool permits a larger body. PreparationOutcome references this committed sample, not a later selection of convenient operations. The preparation root function above verifies the closed allocation/outcome set; the full transition root is `identityHash("transition", {preparationCommitment, preparationRoot}, canonicalize)`; the preparation root already includes all terminal source hashes. A standalone call to the pure helper is not permission to probe.

State progression is `allocated → slots-consumed → sample-ready|sample-failed|sample-uncertain|sample-not-run → sealed → probe-bound`. Only a complete all-ready mode preparation can enter probe-bound. Ready means the intended barrier occurred and a known owner-bound operation exists, not that delivery succeeded. Unknown completion without proof of the intended barrier is uncertain. Failed/uncertain/not-run outcomes remain sealed and block qualification; they cannot be dropped or replaced. Component runs can record their ready observations without an operation ID where their case is local-only; assertReady is specifically the mode transition check.

IntentStore.consume performs owner-only exclusive publication and directory synchronization under the stable preparation lock before the external call. Already-consumed means inspect/reconcile only, never repeat a mutation. Power loss between consumption and request leaves an uncertain slot even if no request actually left. A new run needs new concrete authorization; copying files or assigning a new run UUID does not reset the old authorization's consumed slots. Lock/intent namespace is authorization ID plus preparation commitment, independent of output directory, and covers competing local processes. Task 9's verified deployment exclusion also applies across hosts; without that control live execution refuses.

A lost process reads the same preparation and append-only records, seals consumed slots without final observations as uncertain, and marks remaining allocated samples not_run after safety stop. The final root contains every allocation outcome in original order. Publish one probe-transition record `{version:2, preparationCommitment, preparationRoot, targetHash, mode, probeIds, expectedParentEpoch, newEpoch, probeExpiresAt}`. It binds exactly the three prepared operation IDs, their immutable binding hashes, and the freshly verified target. Include the transition hash in the mode manifest before freezing its RunIdentity. Both roots are required in the manifest, so neither changing filenames nor a later manifest hash can hide preparation failures. The transition record is outside its own digest; the final manifest references its exact byte hash.

Mode operation IDs do not exist at preparation allocation time. They enter the all-ready outcome set; only then may the bounded probe be written. Validate ownership, grant, build/origin, executor, deadlines and immutable binding digest for each existing operation in the control transaction. A batch assertion failure leaves no probe. If probe POST response is uncertain, read the control using the preallocated transition nonce/epoch; never write another epoch automatically. Fix newEpoch before the batch and publish the intended transition first, then append a separate verified receipt after reading authoritative state. Never overwrite the intended transition.

## 5. Profile predicate and expiry inventory (F01, F04)

Task 1 updates these named sites together; no approximate predicate count is accepted:

| File                                        | Function/boundary                  | Required behavior                                                                       |
| ------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| scripts/qualification/preflight.ts          | preflight                          | Parse v2 intent; normal and scratch probes need valid explicit bounded intent           |
| scripts/qualification/cli.ts                | main probe dispatch                | Same profile/intent rules; no alternate early scratch-only refusal                      |
| scripts/qualification/admin.ts              | changeQualification                | Transaction asserts exact bound IDs/ownership/deadlines; persist bounded expiry         |
| scripts/qualification/platform.ts           | verifyQualification                | Verify exact epoch, persisted expiry and probe-ID set for either profile                |
| scripts/qualification/cases/mcp.ts          | sendFixture                        | Exact authorized normal/scratch fixture scope, mutation slots and per-response identity |
| worker/src/operations/recovery-cron.ts      | dueRecoveries                      | Select listed normal or scratch probe rows; reject all unlisted rows                    |
| worker/src/operations/recovery-admission.ts | claimRecovery control selection    | Choose only the intended mode/listed probe and valid expiry                             |
| worker/src/operations/recovery-admission.ts | qualificationFence                 | Enforce epoch/list/expiry on claim, each HTTP admission and common settlement           |
| worker/src/operations/reconcile.ts          | settleRecovered via recoveryFences | No recovery settlement beyond probe expiry                                              |

Use `probeExpiry(now, intent.expiresAt)` for every probe edit; reject expired intent, never refresh beyond the same intent's expiry. The operation's original 24-hour horizon is an additional bound, never extended by probe creation. Existing enabled records retain their separate seven-day lifetime. An enable edit requires unexpired current probe authority and matching verified mode/common evidence, then creates a fresh enabled epoch under separately authorized enable intent; it is not a probe extension.

At expiry there is no grace for a new request, refresh, retry or recovery settlement. A request admitted just before expiry may finish reading within its existing 15-second/attempt deadline, but its result cannot settle through the expired recovery lease. Preserve unknown/manual and let cleanup erase retained session material. A late original direct-send positive receipt may still settle under its existing direct-receipt contract; this is not a recovery probe and must not be reclassified as one.

Required integration schedule: invoke scheduled recovery on a listed normal operation, observe actual due selection, intended-mode lease, zero-body request and one settlement. Repeat with unlisted, foreign owner, disabled, wrong epoch and expired intent. Pause before HTTP, during refresh and before settlement; advance to exact expiry; each subsequent admission/settlement refuses. Test limits at `expiry-1`, `expiry`, `expiry+1`.

## 6. Writer sites (F05)

For each CSV row, define a site key as `identityHash("writer-site", {baselineCommit, path, line, occurrence, sqlSha256}, canonicalize)`. Baseline is `6e78bc548c97bbe5194e3f780c717e5519930c1a`; occurrence is one-based among rows with the same path and line, in original CSV order. Compare sorted arrays of site keys with multiplicity using assertWriterSites; do not use SQL-hash set equality. Require 136 baseline sites, including the seven duplicate-body call sites; 129 unique bodies is only a storage statistic.

The typed fixture adds exact positional binding values (JSON scalar, null or a separately hashed byte fixture), surrounding transaction statements and disposition: guarded-refusal, safe-unrelated or unreachable-with-evidence. Every site has an outcome/state assertion or a source-pinned reachability proof. Reusing a SQL body does not reuse the call site's context. A deleted duplicate-hash site must fail coverage before execution. New production writers need new coverage entries; do not edit the historical baseline to disguise them.

## 7. Restore and execution gates (F06)

QuiescenceVerifier.verify accepts RestoreTarget, obtains a supported authoritative mechanism record, checks database/generation/routed-version hash and current validity, and returns VerifiedQuiescence only inside its implementation module. Parsing QuiescenceRecord or casting it is not verification. No manifest can supply the branded value. Until the mechanism decision is resolved, the implementation throws quiescence_unavailable and cannot invoke restore. Never claim full restore implementation complete based on that refusal path.

Before Tasks 5, 8 and 10 cross from local tooling into target controllers, produce separate decision records for provider barrier, quiescence/deployment exclusion and peak memory. Each record contains the exact mechanism, current primary source, target capabilities, falsifying test and outcome. Unsupported means an explicit unresolved implementation/acceptance gate, not a substitute success. The plan authorizes local preparation of these records; external actions need concrete authorization.

## 8. File and test ownership

All paths in the revised implementation plan are repository-relative. Task 1 owns `scripts/qualification/contracts.ts`, `scripts/qualification/contracts-validation.ts`, `scripts/qualification/controllers/context.ts` and the v2 runner/adapter migration. Task 4 owns durable IntentStore/PrivateSink implementation and crash tests. Task 5 implements both PreparationController and Controller; Tasks 6–7 and 10 use the corresponding pre-execution or run context for their phase. All qualification observations flow through CaseAdapter. Task 8 owns QuiescenceVerifier and RestoreTarget use; Task 9 owns build recipes and deployment exclusion; Task 11 consumes typed CaseReports and ModeEvidence without casting or inventing verdicts.

The executable planning check extracts this first TypeScript block, typechecks it with the repository's strict settings and tests the pure rules. Runtime tasks additionally implement source resolution and verdict derivation exactly as sections 1–7 specify. Passing the planning checker does not demonstrate workerd behavior, device durability, provider barriers, restore quiescence or resource measurement.

## 9. Revision-3 admission and orchestration rules

`credentialVersion` means the Google grant identity epoch, matching `accounts.credential_version`. Access-token refresh preserves it. Reconnect, replacement grant and revoke advance it. The sacrificial credential version has the same meaning. Evidence from an earlier grant cannot qualify a replacement grant.

Mutation adapters own `validateResolvedMutation`; controllers cannot supply a trusted projection. The adapter resolves the committed template and its dependency graph, parses the existing shared tool schema, reconstructs the effective sender and recipients from the actual outgoing MIME or saved draft/reply state, and computes the argument hash from the actual parsed request. It rejects unsupported tools, raw MIME with unverified headers, aliases differing from the authorized sender, extra To/CC/BCC, and conflicting template literals. Both draft creation/update and send need separate slots. ToolCapability names include logical adapter operations such as staging_upload and revoke_account; Task 1 must pin each to its exact existing route/schema and refuse unlisted routes. Native save includes publication only; its remote ACK consumes a separate ack_download slot. Native stage includes local staging preparation only; each remote staging upload consumes a separate staging_upload slot. Native login/logout have native-session slots. A read API cannot dispatch any mutating route.

Private preflight validates the full authorization, allocation budget and DAG before credentials. `admitMutation` resolves the exact persisted ResolvedIntent and template byte hashes, calls the central validator with the verified projection, and returns a branded admission only inside that adapter. The reference validator's template digest uses canonical UTF-8 JSON without a newline; persist IntentTemplate in exactly that encoding. All other artifact hashes continue to cover their exact stored bytes. Implementations revalidate the live target, grant, expiry, actual arguments, tool, sample and body length immediately before consumption and transport. The admission is opaque, one-use and carries the immutable tool binding inside the adapter; type casts confer no authority. No controller receives a credential-bearing arbitrary transport.

`consume` atomically records the full Consumption under the authorization/preparation/sample/slot namespace, synchronizes the record and directory, and returns the committed record. Existing records return their original hashes and byte count. Compare with assertSameConsumption: mismatch is a hard refusal, equality permits read-only reconciliation, and neither permits another mutation. A new consumption is required for each external mutation, including ACK and revoke. Concurrent identical admissions permit one external invocation; a crash after consumption leaves uncertain state. Test two-process races, changed arguments/tool/template, copied directories and lost responses in Task 4.

Manifest fields absent from a phase are forbidden, including explicit null. Recovery prepare has no epoch, root, probe IDs or transition. Probe/run/enable require the exact three prepared IDs. Probe requires an explicit expectedEpoch: a concrete parent epoch or null meaning a transactional assertion that no control exists. Null is never a wildcard. Run/enable require the concrete current probe epoch. Probe references the intended transition; run/enable reference its verified receipt. Disable requires the current expectedEpoch and mode, has no preparation/probe/transition fields, and refuses an absent or newer control. Components permit only prepare/run, one common case, and no mode or epoch. Re-read authoritative state before the conditional admin batch; schema parsing does not provide authority.

Component orchestration is: commit PreparationIdentity and templates → construct fixed component RunIdentity with root=null → perform observation under that identity → persist observation source → persist component-ready PreparationSource referencing that source → close all PreparationOutcomes/root → emit CaseReport with the closed root. Persist failure/uncertain outcomes on interruption. Task 4 tests this order with an event log and verifies that neither source depends on the eventual closure hash.

PrivateSink checks file type/permissions, opens without following symlinks, checks descriptor size and reads with a 65,537-byte overflow sentinel before decoding. Reject overflow and invalid UTF-8 before JSON.parse. Then check depth/key bounds and schemas. Recheck file identity where the platform requires it. Large payloads use separately bounded streaming fixtures, not embedded artifact JSON.

Resource adapters derive requestBytes, responseBytes, attachmentBytes, mimeBytes and fixtureSha256 from counted transport streams and the precommitted fixture. The verifier requires the attachment size 26,214,400, its exact fixture digest, response attachment bytes equal to that size, and request MIME bytes equal to mimeBytes. Record HTTP-envelope bytes separately if the measured route includes them; do not compare HTTP headers to MIME size. Concurrent measurements carry both stream records in the private measurement source and verify their sums. A boolean claim cannot satisfy these predicates.

For reply-revoke, sacrificialTargetHash is H(target, target with the authorized sacrificial account and grant). Source verification checks it and resolvedIntentSha256 against the consumed revoke slot and authorization. Reply observations bind the same sacrificial target. IntentTemplate.targetScope precommits primary or sacrificial; only reply and revoke_account permit sacrificial scope, and revoke requires it. The central validator derives the account/grant from Authorization, preserving the component RunIdentity target. A recovery-mode preparation forbids sacrificial scope.

Runtime implementation remains pending, with provider-barrier, writer-quiescence, and peak-memory feasibility gates explicitly retained.

The component sequence helper awaits each persistence step. sealInterrupted must preserve an already closed outcome/root and append only a diagnostic if report publication failed; it must not replace a ready source or erase a first failure. Source-graph tests in Task 4 enforce the known commitment, fixed identity and exact source references beyond this order-only planning fixture.

RestoreTarget.generation identifies the external generation already rotated and freshly captured in Snapshot.restoreGeneration before the restore request. A proposed next generation is not a RestoreTarget. Recheck both values and routed versions under quiescence; a mismatched snapshot must be recaptured, not patched by the caller.

Writer-count evidence: `docs/superpowers/reviews/2026-09-13-plan-5-writer-inventory.csv` has SHA-256 `11990854f4b0dd41835d27e7740787019c7c56de229ba007ccb0dd431db1cbca`. CSV parsing yields 136 rows, 129 distinct SQL-body hashes and seven additional sites sharing bodies. Recomputing SHA-256 for every stored SQL string matches its row. This verifies inventory counts; Task 3 still must bind parameters and execute every site's disposition against the baseline and current guards.
