import { z } from "zod";
import { canonicalize } from "../../worker/src/crypto/canonical.ts";
import {
  ArtifactRef,
  Authorization,
  Consumption,
  IntentTemplate,
  MutationProjection,
  PreparationIdentity,
  ResolvedIntent,
  assertSameConsumption,
  identityHash,
  validateResolvedMutation,
  type IntentStore,
  type PrivateSink,
} from "./contracts.ts";
import { validateIntentGraph } from "./intent-graph.ts";
import { IntentResultProjection, resolveIntentArguments } from "./intent-resolution.ts";
import type { IntentResults, SealedIntentResult } from "./intent-results.ts";
import { digest } from "./private-files.ts";

/** Implemented only by trusted adapters: describe validates the existing tool schema and effective envelope. */
export interface MutationTransport {
  verifyTarget(): Promise<void>;
  projectResult?(tool: string, result: unknown): Promise<unknown>;
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

/** Local one-shot transport boundary; production adapter bindings remain a separate gate. */
export async function createMutationDispatcher(options: {
  preparation: unknown;
  authorization: unknown;
  intentRefs: unknown;
  sink: PrivateSink;
  store: IntentStore;
  results?: IntentResults;
  now(): number;
  port: MutationTransport;
}) {
  if (Boolean(options.results) !== (typeof options.port.projectResult === "function"))
    throw new Error("preparation_incomplete");
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
    let expectedArgs: Record<string, unknown> = template.literals;
    if (template.references.length) {
      const results = options.results;
      if (!results) throw new Error("preparation_incomplete");
      const sources: SealedIntentResult[] = [];
      for (const reference of template.references) {
        const source = await results.read(reference.sourceSlotId);
        if (!source) throw new Error("preparation_incomplete");
        sources.push(freeze(source));
      }
      expectedArgs = await resolveIntentArguments({
        preparation,
        authorization,
        intentRefs: refs,
        templates,
        resolved,
        sourceRefs: sources.map((source) => source.ref),
        sink: {
          write: (name, value) => options.sink.write(name, value),
          read: (ref) => {
            const source = sources.find((s) => s.ref.name === ref.name && s.ref.sha256 === ref.sha256);
            if (!source) throw new Error("invalid_evidence");
            return Promise.resolve(source.projection);
          },
        },
        readConsumption: async (slotId) => (await results.read(slotId))?.projection.consumption ?? null,
      });
    } else if (resolved.sourceResultHashes.length) throw new Error("invalid_evidence");
    const args = freeze(structuredClone(argsInput));
    if (canonicalize(args) !== canonicalize(expectedArgs) || digest(canonicalize(args)) !== resolved.argumentSha256)
      throw new Error("invalid_evidence");
    if ("idempotency_key" in args && args.idempotency_key !== template.idempotencyKey)
      throw new Error("invalid_evidence");
    const slot = preparation.allocations
      .find((a) => a.sampleId === resolved.sampleId)
      ?.slots.find((s) => s.slotId === resolved.slotId);
    await options.port.verifyTarget();
    let projection = await options.port.describe(template.tool, args);
    const validate = (now = options.now()) =>
      validateResolvedMutation(
        authorization,
        preparation,
        slot,
        template,
        resolved,
        projection,
        commitment,
        now,
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
      const response = await options.port.execute(template.tool, args, template.idempotencyKey);
      if (options.results && options.port.projectResult) {
        const fields = await options.port.projectResult(template.tool, response);
        await options.port.verifyTarget();
        const recordedAt = options.now();
        validate(recordedAt);
        await options.results.seal(
          IntentResultProjection.parse({
            version: 2,
            consumption: request,
            tool: template.tool,
            targetHash: identityHash("target", MutationProjection.parse(projection).target, canonicalize),
            recordedAt,
            fields,
          }),
        );
      }
      return response;
    } catch {
      throw new Error("ambiguous_mutation");
    }
  };
}
