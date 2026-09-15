/** Extract and check the normative planning model; never edits production modules. */
import assert from "node:assert/strict";
import process from "node:process";
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
      include: ["contract.ts"],
    }),
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
      generation: "next",
      routedVersionsSha256: hash,
    };
    assert.equal(c.RestoreTarget.safeParse(t).success, true);
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
  process.stdout.write(
    `Planning contract checks: ${checks} passed; TypeScript strict check passed. No runtime qualification claimed.\n`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
