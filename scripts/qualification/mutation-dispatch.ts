import { z } from "zod";
import { canonicalize } from "../../worker/src/crypto/canonical.ts";
import {
  ArtifactRef,
  Authorization,
  Consumption,
  IntentTemplate,
  PreparationIdentity,
  ResolvedIntent,
  assertSameConsumption,
  identityHash,
  validateResolvedMutation,
  type IntentStore,
  type PrivateSink,
} from "./contracts.ts";
import { validateIntentGraph } from "./intent-graph.ts";
import { digest } from "./private-files.ts";

/** Implemented only by trusted adapters: describe validates the existing tool schema and effective envelope. */
export interface MutationTransport {
  verifyTarget(): Promise<void>;
  describe(tool: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
  execute(tool: string, args: Readonly<Record<string, unknown>>, idempotencyKey: string): Promise<unknown>;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Local one-shot transport boundary. Dependent result resolution and production adapters remain separate gates. */
export async function createMutationDispatcher(options: {
  preparation: unknown;
  authorization: unknown;
  intentRefs: unknown;
  sink: PrivateSink;
  store: IntentStore;
  now(): number;
  port: MutationTransport;
}) {
  const preparation = freeze(PreparationIdentity.parse(options.preparation));
  const authorization = freeze(Authorization.parse(options.authorization));
  const refs = freeze(z.array(ArtifactRef).max(64).parse(options.intentRefs));
  const templates: z.infer<typeof IntentTemplate>[] = [];
  for (const ref of refs) templates.push(IntentTemplate.parse(await options.sink.read(ref)));
  validateIntentGraph(preparation, authorization, refs, templates);
  freeze(templates);
  const commitment = identityHash("preparation-commitment", { identity: preparation, intentRefs: refs }, canonicalize);
  return async (refInput: unknown, argsInput: Record<string, unknown>): Promise<unknown> => {
    const ref = ArtifactRef.parse(refInput);
    const resolved = ResolvedIntent.parse(await options.sink.read(ref));
    const index = templates.findIndex((t) => t.slotId === resolved.slotId && t.sampleId === resolved.sampleId);
    const template = templates[index];
    if (!template || resolved.templateSha256 !== refs[index]!.sha256) throw new Error("invalid_evidence");
    // Refuse until persisted source-result ownership and field resolution are implemented.
    if (template.references.length || resolved.sourceResultHashes.length) throw new Error("preparation_incomplete");
    const args = freeze(structuredClone(argsInput));
    if (
      canonicalize(args) !== canonicalize(template.literals) ||
      digest(canonicalize(args)) !== resolved.argumentSha256
    )
      throw new Error("invalid_evidence");
    if ("idempotency_key" in args && args.idempotency_key !== template.idempotencyKey)
      throw new Error("invalid_evidence");
    const slot = preparation.allocations
      .find((a) => a.sampleId === resolved.sampleId)
      ?.slots.find((s) => s.slotId === resolved.slotId);
    await options.port.verifyTarget();
    let projection = await options.port.describe(template.tool, args);
    const validate = () =>
      validateResolvedMutation(
        authorization,
        preparation,
        slot,
        template,
        resolved,
        projection,
        commitment,
        options.now(),
        canonicalize,
      );
    validate();
    const request = Consumption.parse({
      authorizationId: authorization.authorizationId,
      preparationCommitment: commitment,
      sampleId: resolved.sampleId,
      slotId: resolved.slotId,
      resolvedIntentSha256: ref.sha256,
      templateSha256: resolved.templateSha256,
      argumentSha256: resolved.argumentSha256,
      declaredBytes: template.declaredBytes,
    });
    const result = await options.store.consume(request);
    assertSameConsumption(request, result.committed, canonicalize);
    if (result.status !== "new") throw new Error("ambiguous_mutation");
    // A drift, expiry or crash after consumption spends the slot without granting a retry.
    await options.port.verifyTarget();
    projection = await options.port.describe(template.tool, args);
    validate();
    try {
      return await options.port.execute(template.tool, args, template.idempotencyKey);
    } catch {
      throw new Error("ambiguous_mutation");
    }
  };
}
