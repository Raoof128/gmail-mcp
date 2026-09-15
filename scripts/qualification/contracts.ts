// Runtime v2 contracts. Historical v1 evidence cannot authorize v2 qualification.
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
    preparationClosure: ArtifactRef,
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
