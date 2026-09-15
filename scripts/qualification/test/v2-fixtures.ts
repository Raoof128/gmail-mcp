import { createHash } from "node:crypto";
import { canonicalize } from "../../../worker/src/crypto/canonical.ts";
import { identityHash, preparationRoot, type PrivateSink, type ArtifactRef, type RunIdentity } from "../contracts.ts";
export function fixture(options: { manifestSha256?: string } = {}) {
  const hash = "a".repeat(64);
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const files = new Map<string, { sha256: string; value: unknown }>();
  const put = (name: string, value: unknown): ArtifactRef => {
    const sha256 = createHash("sha256")
      .update(JSON.stringify(value) + "\n")
      .digest("hex");
    files.set(name, { sha256, value });
    return { name, sha256 };
  };
  const sink: PrivateSink = {
    write: (name, value) => Promise.resolve(put(name, value)),
    read: (ref) => {
      const file = files.get(ref.name);
      if (!file || file.sha256 !== ref.sha256) return Promise.reject(new Error("hash mismatch"));
      return Promise.resolve(file.value);
    },
  };
  const target = {
    origin: "https://worker.example",
    platformAccountId: "a".repeat(32),
    workerName: "worker",
    databaseId: uuid(1),
    deploymentId: uuid(2),
    deploymentVersionId: uuid(3),
    workerBuildId: hash,
    qualificationBuildId: hash,
    companionBuildId: hash,
    nativeBuildId: hash,
    configSha256: hash,
    schemaSha256: hash,
    restoreGeneration: "gen",
    profile: "normal" as const,
    compatibilityVersion: 3 as const,
    userId: "owner",
    accountId: "account",
    credentialVersion: 1,
  };
  const auth = {
    version: 2,
    authorizationId: uuid(4),
    targetHash: identityHash("target", target, canonicalize),
    sender: "sender@example.test",
    recipient: "recipient@example.test",
    expiresAt: 9000,
    capabilities: ["power-loss"],
    maxMutations: 0,
    maxWriteBytes: 0,
    sacrificialAccountId: null,
    sacrificialCredentialVersion: null,
  };
  const prep = {
    version: 2,
    preparationId: uuid(5),
    target,
    authorizationSha256: identityHash("authorization", auth, canonicalize),
    purpose: "release-component",
    mode: null,
    createdAt: 100,
    expiresAt: 9000,
    allocations: [1, 2, 3].map((n) => ({ sampleId: uuid(n + 10), caseId: "physical-durability", slots: [] })),
  };
  const identity: RunIdentity = {
    version: 2,
    runId: uuid(6),
    purpose: "release-component",
    target,
    preparationCommitment: identityHash("preparation-commitment", { identity: prep, intentRefs: [] }, canonicalize),
    preparationRoot: null,
    manifestSha256: options.manifestSha256 ?? hash,
    mode: null,
    qualificationEpoch: null,
    probeExpiresAt: null,
    startedAt: 200,
  };
  const sourceRefs: ArtifactRef[] = [];
  const observationRefs: ArtifactRef[] = [];
  const outcomes = prep.allocations.map((a, i) => {
    const observation = {
      version: 2,
      sampleId: a.sampleId,
      identitySha256: identityHash("run", identity, canonicalize),
      surface: "device",
      recordedAt: 300 + i,
      safety: {
        duplicates: 0,
        falseConfirmations: 0,
        unexpectedRecipients: 0,
        credentialLeaks: 0,
        overwrites: 0,
        resourceErrors: 0,
      },
      details: {
        caseId: "physical-durability",
        trial: i + 1,
        deviceSha256: hash,
        physicalLoss: true,
        acknowledgedBeforeLoss: i !== 1,
        recoveredDigestMatches: i !== 1,
        uncertainAcknowledged: false,
      },
    };
    const source = {
      version: 2,
      producer: "power-operator",
      identitySha256: observation.identitySha256,
      sampleId: a.sampleId,
      recordedAt: observation.recordedAt,
      observation,
    };
    const sourceHash = createHash("sha256")
      .update(JSON.stringify(source) + "\n")
      .digest("hex");
    put(`source-${sourceHash}.json`, source);
    observationRefs.push(put(`observation-${i}.json`, { ...observation, sourceSha256: sourceHash }));
    const ready = put(`ready-${i}.json`, {
      version: 2,
      preparationCommitment: identity.preparationCommitment,
      sampleId: a.sampleId,
      producer: "operator",
      event: "component-ready",
      recordedAt: 400 + i,
      operationId: null,
      bindingSha256: null,
      slotJournalRoot: hash,
      observationSourceSha256: sourceHash,
      intendedBarrierReached: false,
      reason: null,
    });
    sourceRefs.push(ready);
    return {
      sampleId: a.sampleId,
      state: "ready",
      operationId: null,
      bindingSha256: null,
      sourceSha256: ready.sha256,
      recordedAt: 400 + i,
      reason: null,
    };
  });
  const root = preparationRoot(prep, outcomes, auth, canonicalize);
  const closure = {
    version: 2,
    identity: prep,
    authorization: put("authorization.json", auth),
    intentRefs: [],
    outcomes,
    sourceRefs,
  };
  const report = {
    version: 2,
    caseId: "physical-durability",
    identity,
    preparationRoot: root,
    preparationClosure: put("closure.json", closure),
    result: "pass",
    limitation: null,
    attempts: 3,
    observationRefs,
  };
  return { sink, identity, report, put, files, closure };
}
