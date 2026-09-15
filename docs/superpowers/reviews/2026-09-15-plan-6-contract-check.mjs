/** Extract and check the normative planning model; never edits production modules. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import process from "node:process";
import { TextEncoder } from "node:util";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalize } from "../../../worker/src/crypto/canonical.ts";
const root = resolve(import.meta.dirname, "../../..");
const appendix = join(root, "docs/superpowers/plans/2026-09-15-plan-6-contracts.md");
const planPath = join(root, "docs/superpowers/plans/2026-09-15-gmail-mcp-plan-6-closure-and-qualification.md");
const text = await readFile(appendix, "utf8");
const code = /```ts\n([\s\S]*?)\n```/.exec(text)?.[1];
assert.ok(code, "normative TypeScript block required");
const dir = await mkdtemp(join(root, ".plan6-contract-check-"));
let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  process.stdout.write(`PASS ${name}\n`);
}
try {
  await writeFile(join(dir, "contract.ts"), code);
  await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      extends: "../tsconfig.base.json",
      compilerOptions: { types: ["node"], noEmit: true, allowImportingTsExtensions: true },
      include: ["contract.ts", "authority-types.ts"],
    }),
  );
  await writeFile(
    join(dir, "authority-types.ts"),
    `
import type { PreparationContext } from "./contract.ts";
declare const context: PreparationContext;
// @ts-expect-error Mutation admission cannot be null.
context.workerMutate(null, "send_message", {});
// @ts-expect-error A slot-less native mutation cannot compile.
context.nativeMutate("sample", "native_stage", {});
// @ts-expect-error Read transport cannot dispatch a send.
context.workerObserve("sample", "send_message", {});
// @ts-expect-error Native observation cannot dispatch a save.
context.nativeObserve("sample", "native_save", {});
`,
  );
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(dir, "tsconfig.json")], {
    stdio: "inherit",
  });
  const c = await import(pathToFileURL(join(dir, "contract.ts")));
  const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const hash = "a".repeat(64);
  const ref = (n) => ({ name: `artifact-${n}.json`, sha256: hash });
  const target = {
    origin: "https://worker.example",
    platformAccountId: "a".repeat(32),
    workerName: "worker",
    databaseId: uid(1),
    deploymentId: uid(2),
    deploymentVersionId: uid(3),
    workerBuildId: hash,
    qualificationBuildId: hash,
    companionBuildId: hash,
    nativeBuildId: hash,
    configSha256: hash,
    schemaSha256: hash,
    restoreGeneration: "generation",
    profile: "normal",
    compatibilityVersion: 3,
    userId: "owner",
    accountId: "account",
    credentialVersion: 1,
  };
  const auth = {
    version: 2,
    authorizationId: uid(4),
    targetHash: c.identityHash("target", target, canonicalize),
    sender: "sender@example.test",
    recipient: "recipient@example.test",
    expiresAt: 100000,
    capabilities: ["send"],
    maxMutations: 3,
    maxWriteBytes: 300,
    sacrificialAccountId: null,
    sacrificialCredentialVersion: null,
  };
  const prep = {
    version: 2,
    preparationId: uid(5),
    target,
    authorizationSha256: c.identityHash("authorization", auth, canonicalize),
    purpose: "recovery-mode",
    mode: "generated_search",
    createdAt: 1000,
    expiresAt: 90000,
    allocations: [1, 2, 3].map((n) => ({
      sampleId: uid(10 + n),
      caseId: "generated-id",
      slots: [{ slotId: uid(20 + n), capability: "send", maxBodyBytes: 100 }],
    })),
  };
  const outcomes = prep.allocations.map((a, n) => ({
    sampleId: a.sampleId,
    state: "ready",
    operationId: `op${n}`,
    bindingSha256: hash,
    sourceSha256: hash,
    recordedAt: 2000,
    reason: null,
  }));
  const identity = {
    version: 2,
    runId: uid(30),
    purpose: "recovery-mode",
    target,
    preparationCommitment: c.identityHash("preparation-commitment", { identity: prep, intentRefs: [] }, canonicalize),
    preparationRoot: c.preparationRoot(prep, outcomes, auth, canonicalize),
    manifestSha256: hash,
    mode: "generated_search",
    qualificationEpoch: "qe_" + "A".repeat(43),
    probeExpiresAt: 90000,
    startedAt: 3000,
  };
  const snapshotHash = c.identityHash("snapshot", c.snapshotOf(target), canonicalize);
  const components = c.CommonCases.map((caseId, n) => ({
    version: 2,
    caseId,
    identity: {
      ...identity,
      purpose: "release-component",
      runId: uid(40 + n),
      preparationRoot: null,
      mode: null,
      qualificationEpoch: null,
      probeExpiresAt: null,
    },
    preparationRoot: hash,
    preparationClosure: ref(98),
    result: "pass",
    limitation: null,
    attempts: 1,
    observationRefs: [ref(n)],
  }));
  const evidence = {
    version: 2,
    purpose: "recovery-mode",
    identity,
    proof: ref(99),
    components: c.CommonCases.map((caseId, n) => ({ caseId, snapshotHash, report: ref(n) })),
  };
  const proof = {
    version: 2,
    caseId: "generated-id",
    identity,
    preparationRoot: identity.preparationRoot,
    preparationClosure: ref(98),
    result: "pass",
    limitation: null,
    attempts: 3,
    observationRefs: [ref(1), ref(2), ref(3)],
  };
  check("F06 strict schema compilation and new reason", () => {
    assert.equal(c.Reason.parse("provider_barrier_unavailable"), "provider_barrier_unavailable");
    assert.equal(c.ModeEvidence.safeParse({ version: 1 }).success, false);
    assert.equal(
      c.ControllerResult.safeParse({ observations: [], limitation: "provider_barrier_unavailable" }).success,
      true,
    );
    assert.equal(c.ControllerResult.safeParse({ observations: [], limitation: null, verdict: "pass" }).success, false);
  });
  check("F02 generated mode has a satisfiable report matrix", () =>
    c.assertModeReports(evidence, proof, components, identity, canonicalize),
  );
  check("F02 status mode has a satisfiable independent report matrix", () => {
    const i = { ...identity, mode: "send_session_status" };
    c.assertModeReports(
      { ...evidence, identity: i },
      { ...proof, caseId: "session-status", identity: i },
      components,
      i,
      canonicalize,
    );
  });
  check("F02 cross-mode proof and missing safety gate refuse", () => {
    assert.throws(() =>
      c.assertModeReports(evidence, { ...proof, caseId: "session-status" }, components, identity, canonicalize),
    );
    assert.throws(() => c.assertModeReports(evidence, proof, components.slice(1), identity, canonicalize));
  });
  check("F02 changed component snapshot refuses", () => {
    const changed = JSON.parse(JSON.stringify(components));
    changed[0].identity.target.qualificationBuildId = "b".repeat(64);
    assert.throws(() => c.assertModeReports(evidence, proof, changed, identity, canonicalize));
  });
  check("F03 full preparation closes and can become ready", () => c.assertReady(outcomes));
  check("F03 omission of a failed sample cannot close allocation", () => {
    const failed = outcomes.map((o, n) => (n === 0 ? { ...o, state: "failed", reason: "case_failed" } : o));
    assert.notEqual(c.preparationRoot(prep, failed, auth, canonicalize), identity.preparationRoot);
    assert.throws(() => c.preparationRoot(prep, failed.slice(1), auth, canonicalize));
    assert.throws(() => c.assertReady(failed));
  });
  check("F03 duplicate and substituted samples refuse", () => {
    assert.throws(() => c.preparationRoot(prep, [outcomes[0], outcomes[0], outcomes[2]], auth, canonicalize));
    assert.throws(() =>
      c.preparationRoot(prep, [{ ...outcomes[0], sampleId: uid(99) }, ...outcomes.slice(1)], auth, canonicalize),
    );
    assert.throws(() => c.assertReady(outcomes.map((o) => ({ ...o, operationId: "same" }))));
  });
  check("F03 uncertain crash can seal after expiry but cannot qualify", () => {
    const crashed = outcomes.map((o) => ({
      ...o,
      state: "uncertain",
      reason: "ambiguous_mutation",
      recordedAt: 100001,
    }));
    c.preparationRoot(prep, crashed, auth, canonicalize);
    assert.throws(() => c.assertReady(crashed));
  });
  check("F03 mutation and byte ceilings refuse excess", () => {
    const limited = { ...auth, maxWriteBytes: 299 };
    const bound = { ...prep, authorizationSha256: c.identityHash("authorization", limited, canonicalize) };
    assert.throws(() => c.preparationRoot(bound, outcomes, limited, canonicalize));
  });
  check("F04 probe expires at authority deadline without grace", () => {
    assert.equal(c.probeExpiry(1000, 2000), 2000);
    assert.equal(c.probeExpiry(1000, 999999999), 604801000);
    assert.throws(() => c.probeExpiry(2000, 2000));
    assert.throws(() => c.probeExpiry(2001, 2000));
  });
  check("F05 site multiplicity detects missing duplicate body", () => {
    const sites = ["site-a:body-x", "site-b:body-x"];
    c.assertWriterSites(sites, [...sites].reverse());
    assert.throws(() => c.assertWriterSites(sites, [sites[0]]));
    assert.throws(() => c.assertWriterSites(sites, [sites[0], sites[0]]));
  });
  check("F06 domain separation and canonical order", () => {
    assert.equal(
      c.identityHash("run", { a: 1, b: 2 }, canonicalize),
      c.identityHash("run", { b: 2, a: 1 }, canonicalize),
    );
    assert.notEqual(c.identityHash("run", { a: 1 }, canonicalize), c.identityHash("target", { a: 1 }, canonicalize));
  });
  check("F06 restore target binds exact database", () => {
    const t = {
      version: 2,
      snapshot: c.snapshotOf(target),
      databaseId: target.databaseId,
      bookmark: "bookmark",
      authorizationSha256: hash,
      authorizationExpiresAt: 100000,
      generation: target.restoreGeneration,
      routedVersionsSha256: hash,
    };
    assert.equal(c.RestoreTarget.safeParse(t).success, true);
    assert.equal(c.RestoreTarget.safeParse({ ...t, generation: "different" }).success, false);
    assert.equal(c.RestoreTarget.safeParse({ ...t, databaseId: uid(99) }).success, false);
  });
  check("F03 preparation source precedes final identity without future hash", () => {
    const source = {
      version: 2,
      preparationCommitment: identity.preparationCommitment,
      sampleId: prep.allocations[0].sampleId,
      producer: "google-controller",
      event: "barrier-ready",
      recordedAt: 2000,
      operationId: "op0",
      bindingSha256: hash,
      slotJournalRoot: hash,
      observationSourceSha256: null,
      intendedBarrierReached: true,
      reason: null,
    };
    assert.equal(c.PreparationSource.safeParse(source).success, true);
    assert.equal(
      c.PreparationSource.safeParse({
        ...source,
        event: "component-ready",
        operationId: null,
        bindingSha256: null,
        intendedBarrierReached: false,
        observationSourceSha256: hash,
      }).success,
      true,
    );
    assert.equal(c.PreparationSource.safeParse({ ...source, identitySha256: hash }).success, false);
    assert.equal(c.RunIdentity.safeParse(components[0].identity).success, true);
    assert.equal(c.RunIdentity.safeParse({ ...identity, preparationRoot: null }).success, false);
  });
  check("F03 dependency templates permit handles but reject recipient substitution", () => {
    const reference = {
      targetPath: ["download_id"],
      sourceSampleId: uid(11),
      sourceSlotId: uid(21),
      field: "download_id",
    };
    assert.equal(c.ArgumentReference.safeParse(reference).success, true);
    assert.equal(
      c.ArgumentReference.safeParse({ ...reference, targetPath: ["handle"], field: "handle" }).success,
      true,
    );
    assert.equal(c.ArgumentReference.safeParse({ ...reference, targetPath: ["to", 0] }).success, false);
    assert.equal(c.ArgumentReference.safeParse({ ...reference, field: "access_token" }).success, false);
  });
  const plan = await readFile(planPath, "utf8");
  check("F01 plan includes scheduled selector and full boundary inventory", () => {
    for (const required of [
      "dueRecoveries",
      "claimRecovery",
      "qualificationFence",
      "settleRecovered",
      "scripts/qualification/cases/mcp.ts",
    ])
      assert.ok(text.includes(required));
    assert.ok(plan.includes("worker/src/operations/recovery-cron.ts"));
    assert.ok(plan.includes("scheduled selection→claim→zero-body request→settlement"));
    assert.ok(!plan.includes("all five"));
  });
  check("F06 all twelve tasks and bounded case payloads retained", () => {
    assert.equal([...plan.matchAll(/^## Task \d+:/gm)].length, 12);
    for (const caseId of c.CaseIds) assert.ok(code.includes(`caseId: z.literal("${caseId}")`));
    assert.ok(!plan.includes("per target mode"));
    assert.ok(!plan.includes("new Set(coveredHashes)"));
  });
  const digest = (v) => createHash("sha256").update(canonicalize(v)).digest("hex");
  const template = {
    version: 2,
    allocationHash: c.identityHash("preparation", prep, canonicalize),
    sampleId: uid(11),
    slotId: uid(21),
    capability: "send",
    tool: "send_message",
    targetScope: "primary",
    literals: { to: [auth.recipient] },
    references: [],
    idempotencyKey: "fixture-1",
    declaredBytes: 100,
  };
  const resolved = {
    version: 2,
    preparationCommitment: identity.preparationCommitment,
    templateSha256: digest(template),
    sampleId: uid(11),
    slotId: uid(21),
    argumentSha256: hash,
    sourceResultHashes: [],
    recordedAt: 2000,
  };
  const projection = {
    tool: "send_message",
    target,
    sender: auth.sender,
    to: [auth.recipient],
    cc: [],
    bcc: [],
    argumentSha256: hash,
    requestBytes: 100,
  };
  const validate = (m = projection, t = template, r = resolved, slot = prep.allocations[0].slots[0]) =>
    c.validateResolvedMutation(auth, prep, slot, t, r, m, identity.preparationCommitment, 3000, canonicalize);
  check("B1 consumed slots bind exact intent and request across restarts", () => {
    const request = {
      authorizationId: auth.authorizationId,
      preparationCommitment: identity.preparationCommitment,
      sampleId: uid(11),
      slotId: uid(21),
      resolvedIntentSha256: hash,
      templateSha256: digest(template),
      argumentSha256: hash,
      declaredBytes: 100,
    };
    c.assertSameConsumption(request, { ...request }, canonicalize);
    for (const key of ["resolvedIntentSha256", "templateSha256", "argumentSha256"])
      assert.throws(() => c.assertSameConsumption(request, { ...request, [key]: "b".repeat(64) }, canonicalize));
    assert.equal(c.Consumption.safeParse({ ...request, resolvedIntentSha256: undefined }).success, false);
  });
  check("B2 B3 M6 exact authorization capability tool and recipient boundary", () => {
    validate();
    for (const change of [
      { sender: "other@example.test" },
      { to: ["other@example.test"] },
      { to: [auth.recipient, "other@example.test"] },
      { cc: [auth.recipient] },
      { bcc: [auth.recipient] },
      { tool: "native_stage" },
      { argumentSha256: "b".repeat(64) },
      { requestBytes: 101 },
      { target: { ...target, credentialVersion: 2 } },
    ])
      assert.throws(() => validate({ ...projection, ...change }));
    assert.throws(() => validate(projection, { ...template, capability: "staging" }));
    assert.throws(() => validate(projection, template, { ...resolved, templateSha256: "b".repeat(64) }));
    assert.ok(!code.includes("workerRequest("));
    assert.ok(!code.includes("nativeRequest("));
    assert.equal(c.ToolCapability.native_save, "download");
    assert.equal(c.ToolCapability.native_stage, "staging");
    assert.equal(c.ToolCapability.ack_download, "download");
  });
  check("B2 native mutation requires its explicit capability and allocated slot", () => {
    for (const tool of ["native_stage", "native_save", "native_login", "native_logout", "ack_download"]) {
      const capability = c.ToolCapability[tool];
      const a = { ...auth, capabilities: [capability] };
      const p = {
        ...prep,
        authorizationSha256: c.identityHash("authorization", a, canonicalize),
        purpose: "release-component",
        mode: null,
        allocations: [
          { sampleId: uid(11), caseId: "native", slots: [{ slotId: uid(21), capability, maxBodyBytes: 100 }] },
        ],
      };
      const t = { ...template, capability, tool, allocationHash: c.identityHash("preparation", p, canonicalize) };
      const r = { ...resolved, templateSha256: digest(t) };
      const m = { ...projection, tool, sender: null, to: [] };
      c.validateResolvedMutation(
        a,
        p,
        p.allocations[0].slots[0],
        t,
        r,
        m,
        identity.preparationCommitment,
        3000,
        canonicalize,
      );
      assert.throws(() =>
        c.validateResolvedMutation(
          a,
          p,
          { ...p.allocations[0].slots[0], slotId: uid(99) },
          t,
          r,
          m,
          identity.preparationCommitment,
          3000,
          canonicalize,
        ),
      );
    }
  });
  check("M5 sacrificial reply and revoke bind exact authorized account and grant", () => {
    for (const tool of ["reply", "revoke_account"]) {
      const capability = c.ToolCapability[tool];
      const a = {
        ...auth,
        capabilities: [capability],
        sacrificialAccountId: "sacrificial",
        sacrificialCredentialVersion: 7,
      };
      const p = {
        ...prep,
        purpose: "release-component",
        mode: null,
        authorizationSha256: c.identityHash("authorization", a, canonicalize),
        allocations: [
          { sampleId: uid(11), caseId: "reply-revoke", slots: [{ slotId: uid(21), capability, maxBodyBytes: 100 }] },
        ],
      };
      const t = {
        ...template,
        capability,
        tool,
        targetScope: "sacrificial",
        allocationHash: c.identityHash("preparation", p, canonicalize),
      };
      const r = { ...resolved, templateSha256: digest(t) };
      const m = {
        ...projection,
        tool,
        target: { ...target, accountId: "sacrificial", credentialVersion: 7 },
        sender: tool === "reply" ? auth.sender : null,
        to: tool === "reply" ? [auth.recipient] : [],
      };
      c.validateResolvedMutation(
        a,
        p,
        p.allocations[0].slots[0],
        t,
        r,
        m,
        identity.preparationCommitment,
        3000,
        canonicalize,
      );
      assert.throws(() =>
        c.validateResolvedMutation(
          a,
          p,
          p.allocations[0].slots[0],
          t,
          r,
          { ...m, target: { ...m.target, credentialVersion: 8 } },
          identity.preparationCommitment,
          3000,
          canonicalize,
        ),
      );
    }
  });
  const baseManifest = {
    version: 2,
    target,
    authorization: ref(1),
    privateDirectory: "/private/fixture",
    deploymentReceipt: ref(2),
    resultName: "result.json",
    deploymentExclusionEvidence: ref(3),
  };
  check("B4 seven exact manifest shapes reject phase contamination", () => {
    const prepare = {
      ...baseManifest,
      purpose: "recovery-mode",
      phase: "prepare",
      mode: "generated_search",
      caseIds: ["generated-id"],
      preparation: ref(4),
      preparationCommitment: hash,
    };
    const probe = {
      ...prepare,
      phase: "probe",
      preparationRoot: hash,
      transition: ref(5),
      expectedEpoch: identity.qualificationEpoch,
      probeIds: ["op1", "op2", "op3"],
    };
    const disable = {
      ...baseManifest,
      purpose: "recovery-mode",
      phase: "disable",
      mode: "generated_search",
      expectedEpoch: identity.qualificationEpoch,
    };
    const component = {
      ...baseManifest,
      purpose: "release-component",
      phase: "prepare",
      caseIds: ["native"],
      preparation: ref(4),
      preparationCommitment: hash,
    };
    for (const good of [
      prepare,
      probe,
      { ...probe, expectedEpoch: null },
      { ...probe, phase: "run" },
      { ...probe, phase: "enable", modeEvidence: ref(6) },
      disable,
      component,
      { ...component, phase: "run" },
    ])
      assert.equal(c.ManifestV2.safeParse(good).success, true);
    for (const bad of [
      { ...prepare, expectedEpoch: null },
      { ...prepare, preparationRoot: hash },
      { ...disable, expectedEpoch: null },
      { ...probe, phase: "run", expectedEpoch: null },
      { ...disable, transition: ref(5) },
      { ...component, phase: "disable" },
      { ...component, mode: null },
      { ...probe, probeIds: ["op1", "op1", "op3"] },
      { ...probe, mode: "send_session_status" },
      { ...probe, phase: "enable" },
    ])
      assert.equal(c.ManifestV2.safeParse(bad).success, false);
  });
  check("M3 artifact byte cap precedes parsing and rejects malformed input", () => {
    assert.throws(() => c.parsePrivateArtifact(new Uint8Array(65537)), /artifact_too_large/);
    assert.throws(() => c.parsePrivateArtifact(new Uint8Array([255])));
    assert.deepEqual(c.parsePrivateArtifact(new TextEncoder().encode('{"ok":true}')), { ok: true });
    let nested = 0;
    for (let i = 0; i < 10; i++) nested = { nested };
    assert.throws(() => c.parsePrivateArtifact(new TextEncoder().encode(JSON.stringify(nested))), /too_deep/);
  });
  const events = [];
  const phases = [
    "commitPreparation",
    "startIdentityWithNullRoot",
    "observe",
    "persistObservationSource",
    "persistComponentReadySource",
    "closeOutcomes",
    "emitReport",
  ];
  const steps = Object.fromEntries(
    phases.map((phase) => [
      phase,
      async () => {
        events.push(phase);
      },
    ]),
  );
  steps.sealInterrupted = async () => {
    events.push("sealInterrupted");
  };
  await c.runComponentSequence(steps);
  check("M2 component sources close after fixed identity and observation", () => assert.deepEqual(events, phases));
  events.length = 0;
  await assert.rejects(
    c.runComponentSequence({
      ...steps,
      observe: async () => {
        throw new Error("lost");
      },
    }),
    /lost/,
  );
  check("M2 interrupted component seals without a ready source or report", () =>
    assert.deepEqual(events, ["commitPreparation", "startIdentityWithNullRoot", "sealInterrupted"]),
  );
  check("M4 resource observations require measured byte and fixture fields", () => {
    const observation = {
      version: 2,
      sampleId: uid(11),
      identitySha256: hash,
      sourceSha256: hash,
      surface: "live",
      recordedAt: 3000,
      safety: {
        duplicates: 0,
        falseConfirmations: 0,
        unexpectedRecipients: 0,
        credentialLeaks: 0,
        overwrites: 0,
        resourceErrors: 0,
      },
      details: {
        caseId: "resources",
        step: "serial",
        ordinal: 1,
        requestBytes: 35000000,
        responseBytes: 26214400,
        fixtureSha256: hash,
        attachmentBytes: 26214400,
        mimeBytes: 35000000,
        concurrentStreams: 0,
        peakMemoryBytes: 10000000,
        cpuMs: 10,
        routeCpuLimitMs: 100,
        measurementSourceSha256: hash,
        coverageComplete: true,
      },
    };
    assert.equal(c.Observation.safeParse(observation).success, true);
    assert.equal(
      c.Observation.safeParse({ ...observation, details: { ...observation.details, attachmentBytes: 1 } }).success,
      false,
    );
    assert.equal(
      c.Observation.safeParse({
        ...observation,
        details: { ...observation.details, fixtureSha256: undefined, maxPayload: true },
      }).success,
      false,
    );
  });
  const register = await readFile(
    join(root, "docs/superpowers/plans/2026-09-15-gmail-mcp-deferred-feature-register.md"),
    "utf8",
  );
  check("B6 M7 M8 retired IOU and release scope remain explicit", () => {
    assert.ok(register.includes("P6-AUDIT-HEADER") && register.includes("Retired; not planned for V1"));
    assert.ok(!plan.includes("Run the eleven cases"));
    assert.ok(!plan.includes("journal/key export"));
    assert.ok(
      plan.includes(
        "Runtime implementation remains pending, with provider-barrier, writer-quiescence, and peak-memory feasibility gates explicitly retained.",
      ),
    );
  });
  process.stdout.write(
    `Planning contract checks: ${checks} passed; TypeScript strict check passed. No runtime qualification claimed.\n`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
