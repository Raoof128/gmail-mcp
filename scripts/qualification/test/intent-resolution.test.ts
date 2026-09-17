import { expect, it, vi } from "vitest";
import { canonicalize } from "../../../worker/src/crypto/canonical.ts";
import { Authorization, PreparationIdentity, IntentTemplate, identityHash } from "../contracts.ts";
import { digest } from "../private-files.ts";
import { resolveIntentArguments } from "../intent-resolution.ts";
import { fixture } from "./v2-fixtures.ts";

function setup() {
  const f = fixture();
  const authorization = Authorization.parse({
    ...(f.files.get("authorization.json")!.value as object),
    capabilities: ["staging", "send"],
    maxMutations: 2,
    maxWriteBytes: 20,
  });
  const sampleId = f.closure.identity.allocations[0]!.sampleId;
  const slots = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const preparation = PreparationIdentity.parse({
    ...f.closure.identity,
    authorizationSha256: identityHash("authorization", authorization, canonicalize),
    allocations: [
      {
        sampleId,
        caseId: "byte-round-trip",
        slots: slots.map((slotId, i) => ({ slotId, capability: i ? "send" : "staging", maxBodyBytes: 10 })),
      },
    ],
  });
  const templates = slots.map((slotId, i) =>
    IntentTemplate.parse({
      version: 2,
      allocationHash: identityHash("preparation", preparation, canonicalize),
      sampleId,
      slotId,
      capability: i ? "send" : "staging",
      tool: i ? "send_message" : "staging_upload",
      targetScope: "primary",
      literals: {},
      references: i
        ? [
            {
              targetPath: ["attachments", 0, "handle"],
              sourceSampleId: sampleId,
              sourceSlotId: slots[0],
              field: "handle",
            },
          ]
        : [],
      idempotencyKey: `key-${i}`,
      declaredBytes: 10,
    }),
  );
  const intentRefs = templates.map((t, i) => ({ name: `template-${i}.json`, sha256: digest(canonicalize(t)) }));
  const commitment = identityHash("preparation-commitment", { identity: preparation, intentRefs }, canonicalize);
  const consumption = {
    authorizationId: authorization.authorizationId,
    preparationCommitment: commitment,
    sampleId,
    slotId: slots[0]!,
    resolvedIntentSha256: "a".repeat(64),
    templateSha256: intentRefs[0]!.sha256,
    argumentSha256: digest("{}"),
    declaredBytes: 10,
  };
  const source = {
    version: 2,
    consumption,
    tool: "staging_upload",
    targetHash: identityHash("target", preparation.target, canonicalize),
    recordedAt: 200,
    fields: { handle: "captured-handle" },
  };
  const publish = () => f.put("result.json", source);
  const sourceRef = publish();
  const args = { attachments: [{ handle: "captured-handle" }] };
  const resolved = {
    version: 2,
    preparationCommitment: commitment,
    templateSha256: intentRefs[1]!.sha256,
    sampleId,
    slotId: slots[1],
    argumentSha256: digest(canonicalize(args)),
    sourceResultHashes: [sourceRef.sha256],
    recordedAt: 300,
  };
  const readConsumption = vi.fn(() => Promise.resolve(consumption));
  const options = {
    preparation,
    authorization,
    intentRefs,
    templates,
    resolved,
    sink: f.sink,
    sourceRefs: [sourceRef],
    readConsumption,
  };
  return { ...f, options, source, publish, args, consumption };
}
it("reconstructs nested arguments from an earlier consumed slot without changing literals", async () => {
  const f = setup();
  await expect(resolveIntentArguments(f.options)).resolves.toEqual(f.args);
  expect(f.options.templates[1]!.literals).toEqual({});
  expect(f.options.readConsumption).toHaveBeenCalledWith(f.consumption.slotId);
});
it.each(["hash", "slot", "tool", "target", "time", "field", "extra", "journal", "commitment", "arguments"])(
  "rejects altered %s provenance",
  async (change) => {
    const f = setup();
    if (change === "hash") f.options.resolved.sourceResultHashes[0] = "f".repeat(64);
    if (change === "slot") f.source.consumption = { ...f.consumption, slotId: f.options.templates[1]!.slotId };
    if (change === "tool") f.source.tool = "send_message";
    if (change === "target") f.source.targetHash = "f".repeat(64);
    if (change === "time") f.source.recordedAt = 301;
    if (change === "field") f.source.fields = { handle: "" };
    if (change === "extra") Object.assign(f.source.fields, { token: "must-not-be-retained" });
    if (change === "journal")
      f.options.readConsumption.mockResolvedValue({ ...f.consumption, argumentSha256: "f".repeat(64) });
    if (change === "commitment") f.options.resolved.preparationCommitment = "f".repeat(64);
    if (change === "arguments") f.options.resolved.argumentSha256 = "f".repeat(64);
    if (change !== "hash") {
      f.options.sourceRefs = [f.publish()];
      f.options.resolved.sourceResultHashes = f.options.sourceRefs.map((ref) => ref.sha256);
    }
    await expect(resolveIntentArguments(f.options)).rejects.toThrow();
  },
);
it.each([
  ["attachments", 1, "handle"],
  ["attachments", "0", "handle"],
  ["attachments", "constructor", "handle"],
])("rejects sparse or unsafe paths %j", async (...path) => {
  const f = setup();
  f.options.templates[1]!.references[0]!.targetPath = path;
  f.options.templates[1]!.literals = { attachments: [] };
  // Recommit the changed graph so rejection exercises path semantics, not stale hashes.
  f.options.intentRefs[1]!.sha256 = digest(canonicalize(f.options.templates[1]));
  const commitment = identityHash(
    "preparation-commitment",
    { identity: f.options.preparation, intentRefs: f.options.intentRefs },
    canonicalize,
  );
  f.consumption.preparationCommitment = commitment;
  f.options.resolved.preparationCommitment = commitment;
  f.options.resolved.templateSha256 = f.options.intentRefs[1]!.sha256;
  f.options.sourceRefs = [f.publish()];
  f.options.resolved.sourceResultHashes = f.options.sourceRefs.map((ref) => ref.sha256);
  await expect(resolveIntentArguments(f.options)).rejects.toThrow();
});
it("refuses an absent consumed source, a missing declared field and mismatched source count", async () => {
  const f = setup();
  await expect(resolveIntentArguments({ ...f.options, readConsumption: () => Promise.resolve(null) })).rejects.toThrow(
    "preparation_incomplete",
  );
  await expect(resolveIntentArguments({ ...f.options, sourceRefs: [] })).rejects.toThrow("invalid_evidence");
  const changed = { ...f.source, fields: { operation_id: "valid-but-not-requested" } };
  const ref = f.put("result.json", changed);
  await expect(
    resolveIntentArguments({
      ...f.options,
      sourceRefs: [ref],
      resolved: { ...f.options.resolved, sourceResultHashes: [ref.sha256] },
    }),
  ).rejects.toThrow("preparation_incomplete");
});
it("refuses results before preparation and resolution at expiration", async () => {
  const f = setup();
  f.source.recordedAt = f.options.preparation.createdAt - 1;
  const ref = f.publish();
  await expect(
    resolveIntentArguments({
      ...f.options,
      sourceRefs: [ref],
      resolved: { ...f.options.resolved, sourceResultHashes: [ref.sha256] },
    }),
  ).rejects.toThrow("invalid_evidence");
  await expect(
    resolveIntentArguments({
      ...f.options,
      resolved: { ...f.options.resolved, recordedAt: f.options.preparation.expiresAt },
    }),
  ).rejects.toThrow("invalid_evidence");
});
