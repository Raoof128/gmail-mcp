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
