import { z } from "zod";
import { canonicalize } from "../../worker/src/crypto/canonical.ts";
import {
  ArtifactRef,
  Authorization,
  IntentTemplate,
  MutationTools,
  PreparationIdentity,
  ToolCapability,
  identityHash,
} from "./contracts.ts";
import { digest, writePrivateJson } from "./private-files.ts";

/** Validate the entire precommitted DAG before any credential-bearing adapter is constructed. */
export function validateIntentGraph(
  preparationInput: unknown,
  authorizationInput: unknown,
  refsInput: unknown,
  templatesInput: unknown,
): void {
  const prep = PreparationIdentity.parse(preparationInput);
  const auth = Authorization.parse(authorizationInput);
  const refs = z.array(ArtifactRef).max(64).parse(refsInput);
  const templates = z.array(IntentTemplate).max(64).parse(templatesInput);
  const slots = prep.allocations.flatMap((a) => a.slots.map((s) => ({ sampleId: a.sampleId, ...s })));
  if (
    prep.authorizationSha256 !== identityHash("authorization", auth, canonicalize) ||
    auth.targetHash !== identityHash("target", prep.target, canonicalize) ||
    prep.expiresAt > auth.expiresAt ||
    slots.length !== templates.length ||
    slots.length !== refs.length ||
    slots.length > auth.maxMutations ||
    new Set(slots.map((s) => s.slotId)).size !== slots.length ||
    slots.reduce((sum, s) => sum + s.maxBodyBytes, 0) > auth.maxWriteBytes
  )
    throw new Error("intent graph refused");
  for (const [i, t] of templates.entries()) {
    const slot = slots[i]!;
    const tool = MutationTools.parse(t.tool);
    if (
      refs[i]!.sha256 !== digest(canonicalize(t)) ||
      t.allocationHash !== identityHash("preparation", prep, canonicalize) ||
      t.slotId !== slot.slotId ||
      t.sampleId !== slot.sampleId ||
      t.capability !== slot.capability ||
      ToolCapability[tool] !== t.capability ||
      !auth.capabilities.includes(t.capability) ||
      t.declaredBytes > slot.maxBodyBytes ||
      (t.targetScope === "sacrificial" &&
        (prep.purpose === "recovery-mode" ||
          !["reply", "revoke_account"].includes(tool) ||
          auth.sacrificialAccountId === null)) ||
      (tool === "revoke_account" && t.targetScope !== "sacrificial")
    )
      throw new Error("intent graph refused");
    const paths: string[][] = [];
    for (const ref of t.references) {
      const sourceIndex = templates.findIndex(
        (s) => s.sampleId === ref.sourceSampleId && s.slotId === ref.sourceSlotId,
      );
      const path = ref.targetPath.map(String);
      if (
        sourceIndex < 0 ||
        sourceIndex >= i ||
        path.some((p) => ["__proto__", "prototype", "constructor"].includes(p)) ||
        paths.some((p) => p.slice(0, Math.min(p.length, path.length)).every((v, n) => v === path[n]))
      )
        throw new Error("intent dependency refused");
      paths.push(path);
      let current: unknown = t.literals;
      for (const [position, segment] of ref.targetPath.entries()) {
        if (current === null || typeof current !== "object" || (Array.isArray(current) && typeof segment !== "number"))
          throw new Error("literal replacement refused");
        if (!Object.hasOwn(current, segment)) break;
        if (position === ref.targetPath.length - 1) throw new Error("literal replacement refused");
        current = (current as Record<string | number, unknown>)[segment];
      }
    }
  }
}

/** IntentTemplate is the sole artifact whose reviewed contract omits the trailing newline. */
export async function writeIntentTemplate(
  directory: string,
  name: string,
  input: unknown,
): Promise<z.infer<typeof ArtifactRef>> {
  const template = IntentTemplate.parse(input);
  ArtifactRef.shape.name.parse(name);
  return { name, sha256: await writePrivateJson(directory, name, template, "canonical") };
}
