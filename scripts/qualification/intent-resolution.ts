import { z } from "zod";
import { canonicalize } from "../../worker/src/crypto/canonical.ts";
import {
  ArtifactRef,
  Authorization,
  Consumption,
  Hash,
  Id,
  IntentTemplate,
  PreparationIdentity,
  ResolvedIntent,
  assertSameConsumption,
  identityHash,
  type PrivateSink,
} from "./contracts.ts";
import { validateIntentGraph } from "./intent-graph.ts";
import { digest } from "./private-files.ts";

/** Minimal private projection. Raw provider responses, tokens and signed URLs are never evidence fields. */
export const IntentResultProjection = z
  .object({
    version: z.literal(2),
    consumption: Consumption,
    tool: Id,
    targetHash: Hash,
    recordedAt: z.number().int().nonnegative(),
    fields: z
      .object({
        handle: Id.optional(),
        download_id: Id.optional(),
        action_id: Id.optional(),
        message_id: Id.optional(),
        thread_id: Id.optional(),
        operation_id: Id.optional(),
      })
      .strict()
      .refine((fields) => Object.values(fields).some((value) => value !== undefined)),
  })
  .strict();

function insert(root: Record<string, unknown>, path: (string | number)[], value: string): void {
  let cursor: Record<string | number, unknown> = root;
  for (let index = 0; index < path.length; index++) {
    const key = path[index]!;
    if (
      ["__proto__", "constructor", "prototype"].includes(String(key)) ||
      (Array.isArray(cursor) ? typeof key !== "number" || key > cursor.length : typeof key !== "string")
    )
      throw new Error("intent dependency refused");
    const exists = Object.hasOwn(cursor, key);
    if (index === path.length - 1) {
      if (exists) throw new Error("literal replacement refused");
      cursor[key] = value;
    } else {
      if (!exists) cursor[key] = typeof path[index + 1] === "number" ? [] : {};
      const child = cursor[key];
      if (child === null || typeof child !== "object") throw new Error("literal replacement refused");
      cursor = child as Record<string | number, unknown>;
    }
  }
}

/**
 * Local evidence validation only; this does not grant mutation authority or prove provider settlement.
 * The private sink checks source bytes; readConsumption must use the host journal.
 * Production dispatch remains closed until a trusted transport publishes these projections durably.
 */
export async function resolveIntentArguments(options: {
  preparation: unknown;
  authorization: unknown;
  intentRefs: unknown;
  templates: unknown;
  resolved: unknown;
  sink: PrivateSink;
  sourceRefs: unknown;
  readConsumption(slotId: string): Promise<Consumption | null>;
}): Promise<Record<string, unknown>> {
  const preparation = PreparationIdentity.parse(options.preparation);
  const authorization = Authorization.parse(options.authorization);
  const intentRefs = z.array(ArtifactRef).max(64).parse(options.intentRefs);
  const templates = z.array(IntentTemplate).max(64).parse(options.templates);
  const resolved = ResolvedIntent.parse(options.resolved);
  const sourceRefs = z.array(ArtifactRef).max(8).parse(options.sourceRefs);
  validateIntentGraph(preparation, authorization, intentRefs, templates);
  const commitment = identityHash("preparation-commitment", { identity: preparation, intentRefs }, canonicalize);
  const index = templates.findIndex((t) => t.slotId === resolved.slotId && t.sampleId === resolved.sampleId);
  const template = templates[index];
  if (
    !template ||
    resolved.preparationCommitment !== commitment ||
    resolved.templateSha256 !== intentRefs[index]!.sha256 ||
    resolved.recordedAt < preparation.createdAt ||
    resolved.recordedAt >= preparation.expiresAt ||
    resolved.sourceResultHashes.length !== template.references.length ||
    sourceRefs.length !== template.references.length ||
    sourceRefs.some((ref, i) => ref.sha256 !== resolved.sourceResultHashes[i])
  )
    throw new Error("invalid_evidence");
  const args: Record<string, unknown> = structuredClone(template.literals);
  for (const [position, reference] of template.references.entries()) {
    const source = IntentResultProjection.parse(await options.sink.read(sourceRefs[position]!));
    const sourceIndex = templates.findIndex(
      (t) => t.slotId === reference.sourceSlotId && t.sampleId === reference.sourceSampleId,
    );
    const sourceTemplate = templates[sourceIndex]!;
    const consumption = source.consumption;
    if (
      sourceIndex < 0 ||
      sourceIndex >= index ||
      sourceTemplate.targetScope !== template.targetScope ||
      // Sacrificial templates need an independently bound sacrificial target, which this resolver does not yet accept.
      template.targetScope !== "primary" ||
      source.targetHash !== identityHash("target", preparation.target, canonicalize) ||
      source.tool !== sourceTemplate.tool ||
      consumption.authorizationId !== authorization.authorizationId ||
      consumption.preparationCommitment !== commitment ||
      consumption.sampleId !== reference.sourceSampleId ||
      consumption.slotId !== reference.sourceSlotId ||
      consumption.templateSha256 !== intentRefs[sourceIndex]!.sha256 ||
      consumption.declaredBytes !== sourceTemplate.declaredBytes ||
      source.recordedAt < preparation.createdAt ||
      source.recordedAt > resolved.recordedAt
    )
      throw new Error("invalid_evidence");
    const committed = await options.readConsumption(reference.sourceSlotId);
    if (!committed) throw new Error("preparation_incomplete");
    assertSameConsumption(consumption, committed, canonicalize);
    const value = source.fields[reference.field];
    if (value === undefined) throw new Error("preparation_incomplete");
    insert(args, reference.targetPath, value);
  }
  if (digest(canonicalize(args)) !== resolved.argumentSha256) throw new Error("invalid_evidence");
  return args;
}
