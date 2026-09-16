import { expect, it } from "vitest";
import { mkdtemp, realpath, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIntentStore, openIntentJournal } from "../intent-store.ts";
import { DurableComponentFinalizer } from "../preparation-finalizer.ts";
import { fixture } from "./v2-fixtures.ts";
import { Authorization, Observation, PreparationIdentity, type VerifiedControllerContext } from "../contracts.ts";
import { PreparationClosure, EvidenceVerifier } from "../contracts-validation.ts";
import { SourceCaseAdapter } from "../case-adapter.ts";
async function setup(directory: string) {
  const f = fixture();
  const authorization = Authorization.parse(f.files.get("authorization.json")!.value);
  const store = await createIntentStore(authorization.authorizationId, f.identity.preparationCommitment, directory);
  const unsupported = () => Promise.reject(new Error("unexpected mutation"));
  const context: VerifiedControllerContext = {
    identity: f.identity,
    preparation: PreparationIdentity.parse(f.closure.identity),
    preparationCommitment: f.identity.preparationCommitment,
    authorization,
    sink: f.sink,
    intents: store,
    now: () => 500,
    monotonicNow: () => 500,
    verifyTarget: () => Promise.resolve(),
    admitMutation: unsupported,
    workerObserve: unsupported,
    workerMutate: unsupported,
    nativeObserve: unsupported,
    nativeMutate: unsupported,
  };
  const observations = f.report.observationRefs.map((r) => Observation.parse(f.files.get(r.name)!.value));
  return {
    ...f,
    context,
    observations,
    store,
    finalizer: new DurableComponentFinalizer(store, f.closure.authorization),
  };
}
async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "qualification-finalizer-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
it("read-only reconciliation does not create or consume absent slots", async () =>
  temporary(async (directory) => {
    await expect(
      openIntentJournal("11111111-1111-4111-8111-111111111111", "a".repeat(64), directory),
    ).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
    const f = await setup(directory);
    const before = await readdir(directory);
    const journal = await openIntentJournal(
      f.context.authorization.authorizationId,
      f.identity.preparationCommitment,
      directory,
    );
    expect(await journal.readConsumption(f.context.preparation.allocations[0]!.sampleId)).toBeNull();
    expect(await journal.readSample(f.context.preparation.allocations[0]!.sampleId)).toBeNull();
    expect(await readdir(directory)).toEqual(before);
    await expect(
      openIntentJournal(f.context.authorization.authorizationId, "f".repeat(64), directory),
    ).rejects.toThrow();
  }));
it("seals a full component source graph durably and reopens it without replacing outcomes", async () =>
  temporary(async (directory) => {
    const f = await setup(directory);
    const report = await new SourceCaseAdapter(f.finalizer).run(f.context, "physical-durability", () =>
      Promise.resolve({ observations: f.observations, limitation: null }),
    );
    expect(report.result).toBe("pass");
    await expect(new EvidenceVerifier().validateCase(report, f.sink, f.identity)).resolves.toEqual(report);
    const reopened = await setup(directory);
    const again = await reopened.finalizer.close(reopened.context, {
      observations: reopened.observations,
      limitation: null,
    });
    expect(again).toEqual(report.preparationClosure);
  }));
it("closes omitted samples and preserves the first failure across restart", async () =>
  temporary(async (directory) => {
    const f = await setup(directory);
    const ref = await f.finalizer.close(f.context, {
      observations: f.observations.slice(0, 1),
      limitation: "case_failed",
    });
    const closure = PreparationClosure.parse(await f.sink.read(ref));
    expect(closure.outcomes).toHaveLength(3);
    expect(closure.outcomes.every((o) => o.state !== "ready")).toBe(true);
    const reopened = await setup(directory);
    const retry = await reopened.finalizer.close(reopened.context, {
      observations: reopened.observations,
      limitation: null,
    });
    expect(PreparationClosure.parse(await reopened.sink.read(retry)).outcomes).toEqual(closure.outcomes);
  }));
it("never seals forged observation sources or expired observations as ready", async () =>
  temporary(async (directory) => {
    const f = await setup(directory);
    const altered = f.observations.map((o) => ({ ...o, sourceSha256: "f".repeat(64) }));
    const ref = await f.finalizer.close(f.context, { observations: altered, limitation: null });
    expect(PreparationClosure.parse(await f.sink.read(ref)).outcomes.every((o) => o.state === "failed")).toBe(true);
  }));

it("retains a child process failure after restart and cannot turn it into a pass", async () =>
  temporary(async (directory) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const f = await setup(directory);
    const script = `import { createIntentStore } from ${JSON.stringify(new URL("../intent-store.ts", import.meta.url).href)};
    const store = await createIntentStore(${JSON.stringify(f.context.authorization.authorizationId)}, ${JSON.stringify(f.identity.preparationCommitment)}, ${JSON.stringify(directory)});
    await store.sealSample(${JSON.stringify({
      version: 2,
      preparationCommitment: f.identity.preparationCommitment,
      sampleId: f.context.preparation.allocations[0]!.sampleId,
      producer: "operator",
      event: "sample-uncertain",
      recordedAt: 450,
      operationId: null,
      bindingSha256: null,
      slotJournalRoot: "a".repeat(64),
      observationSourceSha256: null,
      intendedBarrierReached: false,
      reason: "ambiguous_mutation",
    })});
    process.exit(17);`;
    await expect(
      promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 10000, maxBuffer: 4096 }),
    ).rejects.toMatchObject({ code: 17 });
    const reopened = await setup(directory);
    const report = await new SourceCaseAdapter(reopened.finalizer).run(reopened.context, "physical-durability", () =>
      Promise.resolve({ observations: reopened.observations, limitation: null }),
    );
    expect(report.result).toBe("fail");
    const closure = PreparationClosure.parse(await reopened.sink.read(report.preparationClosure));
    expect(closure.outcomes[0]!.state).toBe("uncertain");
    expect(closure.outcomes).toHaveLength(3);
  }));
it("recovers a failure sealed before evidence publication was interrupted", async () =>
  temporary(async (directory) => {
    const f = await setup(directory);
    f.context.sink = { ...f.sink, write: () => Promise.reject(new Error("disk unavailable")) };
    await expect(f.finalizer.close(f.context, { observations: [], limitation: "case_failed" })).rejects.toThrow();
    const reopened = await setup(directory);
    const ref = await reopened.finalizer.close(reopened.context, {
      observations: reopened.observations,
      limitation: null,
    });
    const closure = PreparationClosure.parse(await reopened.sink.read(ref));
    expect(closure.outcomes[0]!.state).toBe("not_run");
    expect(closure.outcomes[0]!.reason).toBe("case_failed");
  }));
it("seals expiry as failure and refuses mutation-bearing preparation", async () =>
  temporary(async (directory) => {
    const f = await setup(directory);
    f.context.now = () => 9000;
    const ref = await f.finalizer.close(f.context, { observations: f.observations, limitation: null });
    const closure = PreparationClosure.parse(await f.sink.read(ref));
    expect(closure.outcomes.every((o) => o.state === "failed" && o.reason === "intent_expired")).toBe(true);
    f.context.preparation.allocations[0]!.slots.push({
      slotId: "33333333-3333-4333-8333-333333333333",
      capability: "send",
      maxBodyBytes: 0,
    });
    await expect(f.finalizer.close(f.context, { observations: [], limitation: null })).rejects.toThrow(
      "mutation_journal_unavailable",
    );
  }));
it("keeps a source checkpoint if the process stops before its outcome record", async () =>
  temporary(async (directory) => {
    const f = await setup(directory);
    f.store.appendOutcome = () => Promise.reject(new Error("interrupted before outcome"));
    await expect(f.finalizer.close(f.context, { observations: [], limitation: "case_failed" })).rejects.toThrow();
    const reopened = await setup(directory);
    const ref = await reopened.finalizer.close(reopened.context, {
      observations: reopened.observations,
      limitation: null,
    });
    expect(PreparationClosure.parse(await reopened.sink.read(ref)).outcomes[0]!.state).toBe("not_run");
  }));
it("does not backdate readiness when source reads cross authorization expiry", async () =>
  temporary(async (directory) => {
    const f = await setup(directory);
    let now = 500;
    f.context.now = () => now;
    f.context.sink = {
      ...f.sink,
      read: async (ref) => {
        const value = await f.sink.read(ref);
        if (ref.name.startsWith("source-")) now = 9000;
        return value;
      },
    };
    const ref = await f.finalizer.close(f.context, { observations: f.observations, limitation: null });
    expect(PreparationClosure.parse(await f.sink.read(ref)).outcomes.every((o) => o.state !== "ready")).toBe(true);
  }));
