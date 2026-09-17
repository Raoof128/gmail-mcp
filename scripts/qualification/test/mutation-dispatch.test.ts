import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { canonicalize } from "../../../worker/src/crypto/canonical.ts";
import { Authorization, PreparationIdentity, IntentTemplate, identityHash, type IntentStore } from "../contracts.ts";
import { digest } from "../private-files.ts";
import { createMutationDispatcher } from "../mutation-dispatch.ts";
import { fixture } from "./v2-fixtures.ts";
async function setup() {
  const f = fixture();
  const authorization = Authorization.parse({
    ...((await f.sink.read(f.closure.authorization)) as object),
    capabilities: ["send"],
    maxMutations: 1,
    maxWriteBytes: 10,
  });
  const sampleId = f.closure.identity.allocations[0]!.sampleId;
  const slotId = "11111111-1111-4111-8111-111111111111";
  const preparation = PreparationIdentity.parse({
    ...f.closure.identity,
    authorizationSha256: identityHash("authorization", authorization, canonicalize),
    allocations: [{ sampleId, caseId: "byte-round-trip", slots: [{ slotId, capability: "send", maxBodyBytes: 10 }] }],
  });
  const args = { to: authorization.recipient, body: "fixture", idempotency_key: "fixture-key" };
  const template = IntentTemplate.parse({
    version: 2,
    allocationHash: identityHash("preparation", preparation, canonicalize),
    sampleId,
    slotId,
    capability: "send",
    tool: "send_message",
    targetScope: "primary",
    literals: args,
    references: [],
    idempotencyKey: "fixture-key",
    declaredBytes: 10,
  });
  const intentRefs = [{ name: "template.json", sha256: digest(canonicalize(template)) }];
  f.files.set("template.json", { value: template, sha256: intentRefs[0]!.sha256 });
  const preparationCommitment = identityHash(
    "preparation-commitment",
    { identity: preparation, intentRefs },
    canonicalize,
  );
  const resolved = {
    version: 2,
    preparationCommitment,
    templateSha256: intentRefs[0]!.sha256,
    sampleId,
    slotId,
    argumentSha256: digest(canonicalize(args)),
    sourceResultHashes: [],
    recordedAt: 200,
  };
  const resolvedRef = f.put("resolved.json", resolved);
  let consumed = false;
  const store = {
    consume: vi.fn<IntentStore["consume"]>((request) => {
      const status = consumed ? "already-consumed" : "new";
      consumed = true;
      return Promise.resolve({ status, committed: request });
    }),
    appendOutcome: vi.fn(),
  };
  const port = {
    verifyTarget: vi.fn(async () => {
      await Promise.resolve();
    }),
    describe: vi.fn(async () => {
      await Promise.resolve();
      return {
        tool: "send_message",
        target: preparation.target,
        sender: authorization.sender,
        to: [authorization.recipient],
        cc: [],
        bcc: [],
        argumentSha256: resolved.argumentSha256,
        requestBytes: 10,
      };
    }),
    execute: vi.fn(async () => {
      await Promise.resolve();
      return { operation_id: "op" };
    }),
  };
  const options = { preparation, authorization, intentRefs, sink: f.sink, store, now: () => 300, port };
  return { ...f, options, port, store, args, resolvedRef, template, resolved };
}
it("consumes before transport and never repeats a consumed or ambiguous mutation", async () => {
  const f = await setup();
  const dispatch = await createMutationDispatcher(f.options);
  f.port.execute.mockRejectedValueOnce(new Error("lost receipt"));
  await expect(dispatch(f.resolvedRef, f.args)).rejects.toThrow("ambiguous_mutation");
  await expect(dispatch(f.resolvedRef, f.args)).rejects.toThrow("ambiguous_mutation");
  expect(f.port.execute).toHaveBeenCalledTimes(1);
  expect(f.store.consume).toHaveBeenCalledTimes(2);
});
it("refuses altered arguments and effective recipients before consumption", async () => {
  const f = await setup();
  const dispatch = await createMutationDispatcher(f.options);
  await expect(dispatch(f.resolvedRef, { ...f.args, body: "changed" })).rejects.toThrow();
  f.port.describe.mockImplementationOnce(async () => {
    await Promise.resolve();
    return {
      tool: "send_message",
      target: f.identity.target,
      sender: "unexpected@example.test",
      to: [f.args.to],
      cc: [],
      bcc: [],
      argumentSha256: f.resolved.argumentSha256,
      requestBytes: 10,
    };
  });
  await expect(dispatch(f.resolvedRef, f.args)).rejects.toThrow();
  expect(f.store.consume).not.toHaveBeenCalled();
  expect(f.port.execute).not.toHaveBeenCalled();
});
it("rechecks expiry and live target after durable consumption without retrying", async () => {
  const f = await setup();
  let clock = 300;
  f.port.verifyTarget.mockImplementation(async () => {
    await Promise.resolve();
    if (f.port.verifyTarget.mock.calls.length === 2) clock = 9000;
  });
  const dispatch = await createMutationDispatcher({ ...f.options, now: () => clock });
  await expect(dispatch(f.resolvedRef, f.args)).rejects.toThrow();
  expect(f.store.consume).toHaveBeenCalledTimes(1);
  expect(f.port.execute).not.toHaveBeenCalled();
});
it("refuses an effective envelope that changes after consumption", async () => {
  const f = await setup();
  const original = f.port.describe.getMockImplementation()!;
  f.port.describe.mockImplementation(async () => ({
    ...(await original()),
    sender: f.port.describe.mock.calls.length > 1 ? "changed@example.test" : "sender@example.test",
  }));
  const dispatch = await createMutationDispatcher(f.options);
  await expect(dispatch(f.resolvedRef, f.args)).rejects.toThrow();
  expect(f.store.consume).toHaveBeenCalledTimes(1);
  expect(f.port.execute).not.toHaveBeenCalled();
});
it.each(["projection", "publication", "drift", "expiry"])("refuses replay after result %s failure", async (failure) => {
  const f = await setup();
  const { openIntentResults } = await import("../intent-results.ts");
  const { createIntentStore } = await import("../intent-store.ts");
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(await realpath(tmpdir()), "qualification-dispatch-result-"));
  try {
    const store = await createIntentStore(
      f.options.authorization.authorizationId,
      f.resolved.preparationCommitment,
      root,
    );
    const results = await openIntentResults(
      f.options.authorization.authorizationId,
      f.resolved.preparationCommitment,
      root,
    );
    const projectResult = vi.fn(() =>
      Promise.resolve(failure === "projection" ? { operation_id: "op", token: "forbidden" } : { operation_id: "op" }),
    );
    if (failure === "publication") vi.spyOn(results, "seal").mockRejectedValue(new Error("sync failed"));
    if (failure === "drift")
      f.port.verifyTarget.mockImplementation(() =>
        f.port.verifyTarget.mock.calls.length === 3 ? Promise.reject(new Error("identity_drift")) : Promise.resolve(),
      );
    const dispatch = await createMutationDispatcher({
      ...f.options,
      store,
      results,
      port: { ...f.port, projectResult },
      now: () => (failure === "expiry" && f.port.verifyTarget.mock.calls.length >= 3 ? 9000 : 300),
    });
    await expect(dispatch(f.resolvedRef, f.args)).rejects.toThrow("ambiguous_mutation");
    expect(await results.read(f.template.slotId)).toBeNull();
    // Expired authority is rejected before the journal is consulted; neither path repeats transport.
    await expect(dispatch(f.resolvedRef, f.args)).rejects.toThrow(
      failure === "expiry" ? "invalid_evidence" : "ambiguous_mutation",
    );
    expect(f.port.execute).toHaveBeenCalledTimes(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("resolves a staged handle through the durable journal and cannot replay either slot after restart", async () => {
  const f = await setup();
  const { openIntentResults } = await import("../intent-results.ts");
  const { createIntentStore } = await import("../intent-store.ts");
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const authorization = Authorization.parse({
    ...f.options.authorization,
    capabilities: ["staging", "send"],
    maxMutations: 2,
    maxWriteBytes: 20,
  });
  const sourceSlot = "22222222-2222-4222-8222-222222222222";
  const preparation = PreparationIdentity.parse({
    ...f.options.preparation,
    authorizationSha256: identityHash("authorization", authorization, canonicalize),
    allocations: [
      {
        ...f.options.preparation.allocations[0],
        slots: [
          { slotId: sourceSlot, capability: "staging", maxBodyBytes: 10 },
          ...f.options.preparation.allocations[0]!.slots,
        ],
      },
    ],
  });
  const allocationHash = identityHash("preparation", preparation, canonicalize);
  const source = IntentTemplate.parse({
    ...f.template,
    allocationHash,
    slotId: sourceSlot,
    capability: "staging",
    tool: "staging_upload",
    literals: {},
    idempotencyKey: "staging-key",
  });
  const destination = IntentTemplate.parse({
    ...f.template,
    allocationHash,
    references: [
      {
        sourceSampleId: source.sampleId,
        sourceSlotId: source.slotId,
        targetPath: ["attachments", 0, "handle"],
        field: "handle",
      },
    ],
  });
  const intentRefs = [source, destination].map((template, i) => {
    const ref = { name: `dependent-${i}.json`, sha256: digest(canonicalize(template)) };
    f.files.set(ref.name, { value: template, sha256: ref.sha256 });
    return ref;
  });
  const commitment = identityHash("preparation-commitment", { identity: preparation, intentRefs }, canonicalize);
  const sourceResolved = f.put("source-resolved.json", {
    ...f.resolved,
    preparationCommitment: commitment,
    templateSha256: intentRefs[0]!.sha256,
    slotId: source.slotId,
    argumentSha256: digest("{}"),
    recordedAt: 300,
  });
  let now = 350;
  const args = { ...f.args, attachments: [{ handle: "staged-handle" }] };
  const root = await mkdtemp(join(await realpath(tmpdir()), "qualification-dependent-dispatch-"));
  try {
    const store = await createIntentStore(authorization.authorizationId, commitment, root);
    const results = await openIntentResults(authorization.authorizationId, commitment, root);
    const port = {
      verifyTarget: f.port.verifyTarget,
      describe: (tool: string, argumentsInput: Readonly<Record<string, unknown>>) =>
        Promise.resolve({
          tool,
          target: preparation.target,
          sender: tool === "send_message" ? authorization.sender : null,
          to: tool === "send_message" ? [authorization.recipient] : [],
          cc: [],
          bcc: [],
          argumentSha256: digest(canonicalize(argumentsInput)),
          requestBytes: 10,
        }),
      execute: vi.fn((tool: string) =>
        Promise.resolve(tool === "staging_upload" ? { handle: "staged-handle" } : { operation_id: "sent-operation" }),
      ),
      projectResult: (_tool: string, response: unknown) => Promise.resolve(response),
    };
    const options = { preparation, authorization, intentRefs, sink: f.sink, store, results, now: () => now, port };
    const dispatch = await createMutationDispatcher(options);
    await expect(dispatch(sourceResolved, {})).resolves.toEqual({ handle: "staged-handle" });
    const captured = await results.read(source.slotId);
    expect(captured?.projection.fields).toEqual({ handle: "staged-handle" });
    now = 500;
    const destinationResolved = f.put("destination-resolved.json", {
      ...f.resolved,
      preparationCommitment: commitment,
      templateSha256: intentRefs[1]!.sha256,
      argumentSha256: digest(canonicalize(args)),
      sourceResultHashes: [captured!.ref.sha256],
      recordedAt: 400,
    });
    await expect(
      dispatch(destinationResolved, { ...args, attachments: [{ handle: "substituted" }] }),
    ).rejects.toThrow();
    await expect(dispatch(destinationResolved, args)).resolves.toEqual({ operation_id: "sent-operation" });
    const reopened = await createMutationDispatcher({
      ...options,
      store: await createIntentStore(authorization.authorizationId, commitment, root),
      results: await openIntentResults(authorization.authorizationId, commitment, root),
    });
    await expect(reopened(sourceResolved, {})).rejects.toThrow("ambiguous_mutation");
    await expect(reopened(destinationResolved, args)).rejects.toThrow("ambiguous_mutation");
    expect(port.execute).toHaveBeenCalledTimes(2);
    expect((await results.read(destination.slotId))?.projection.fields).toEqual({ operation_id: "sent-operation" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
