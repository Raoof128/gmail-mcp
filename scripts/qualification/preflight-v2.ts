import { z } from "zod";
import { basename, dirname, resolve } from "node:path";
import { canonicalize } from "../../worker/src/crypto/canonical.ts";
import {
  ArtifactRef,
  Authorization,
  Hash,
  IntentTemplate,
  MutationTools,
  ToolCapability,
  ManifestV2,
  PreparationIdentity,
  Snapshot,
  identityHash,
  snapshotOf,
} from "./contracts.ts";
import { createPrivateSink, digest, privateDirectory, readPrivateBytes } from "./private-files.ts";
import { parsePrivateArtifact } from "./contracts.ts";
export const DeploymentReceiptV2 = z
  .object({
    version: z.literal(2),
    snapshot: Snapshot,
    bundleSha256: Hash,
    platformScriptEtag: z.string().min(1).max(256),
  })
  .strict();
export const PreparationCommitmentRecord = z
  .object({
    version: z.literal(2),
    identity: PreparationIdentity,
    authorization: ArtifactRef,
    intentRefs: z.array(ArtifactRef).max(64),
  })
  .strict();
export type V2Command = "prepare" | "probe" | "run" | "enable" | "disable";

/** Validates private inputs only. It does not establish live deployment identity or exclusion. */
export async function preflightV2(path: string, command: V2Command, now = Date.now()) {
  const bytes = await readPrivateBytes(path);
  const manifest = ManifestV2.parse(parsePrivateArtifact(bytes));
  if (manifest.phase !== command) throw new Error("manifest phase mismatch");
  const directory = await privateDirectory(manifest.privateDirectory);
  if (dirname(resolve(path)) !== directory) throw new Error("one private evidence directory required");
  const sink = await createPrivateSink(directory);
  const authorization = Authorization.parse(await sink.read(manifest.authorization));
  if (
    !Number.isSafeInteger(now) ||
    authorization.expiresAt <= now ||
    authorization.targetHash !== identityHash("target", manifest.target, canonicalize)
  )
    throw new Error("missing_authorization");
  if ((command === "enable" || command === "disable") && !authorization.capabilities.includes("enable"))
    throw new Error("missing_authorization");
  if (command === "probe" && !authorization.capabilities.includes("send")) throw new Error("missing_authorization");
  const receipt = DeploymentReceiptV2.parse(await sink.read(manifest.deploymentReceipt));
  if (canonicalize(receipt.snapshot) !== canonicalize(snapshotOf(manifest.target)))
    throw new Error("deployment receipt mismatch");
  // Resolve the exact exclusion artifact now; its mechanism must still be verified before credentials.
  const exclusion = await sink.read(manifest.deploymentExclusionEvidence);
  let preparation: z.infer<typeof PreparationCommitmentRecord> | null = null;
  if ("preparation" in manifest) {
    preparation = PreparationCommitmentRecord.parse(await sink.read(manifest.preparation));
    const p = preparation.identity;
    const originalAuthorization = Authorization.parse(await sink.read(preparation.authorization));
    if (
      p.authorizationSha256 !== identityHash("authorization", originalAuthorization, canonicalize) ||
      originalAuthorization.targetHash !== authorization.targetHash ||
      p.expiresAt > originalAuthorization.expiresAt ||
      p.createdAt > now ||
      (command !== "enable" && p.expiresAt <= now) ||
      canonicalize(p.target) !== canonicalize(manifest.target) ||
      p.purpose !== manifest.purpose ||
      p.mode !== ("mode" in manifest ? manifest.mode : null) ||
      (command !== "enable" && p.authorizationSha256 !== identityHash("authorization", authorization, canonicalize))
    )
      throw new Error("preparation binding mismatch");
    if (
      identityHash("preparation-commitment", { identity: p, intentRefs: preparation.intentRefs }, canonicalize) !==
      manifest.preparationCommitment
    )
      throw new Error("preparation commitment mismatch");
    const slots = p.allocations.flatMap((a) => a.slots.map((slot) => ({ sampleId: a.sampleId, ...slot })));
    if (
      slots.length !== preparation.intentRefs.length ||
      new Set(slots.map((s) => s.slotId)).size !== slots.length ||
      slots.length > originalAuthorization.maxMutations ||
      slots.reduce((sum, s) => sum + s.maxBodyBytes, 0) > originalAuthorization.maxWriteBytes ||
      p.allocations.some((a) => !manifest.caseIds.some((id) => id === a.caseId))
    )
      throw new Error("preparation budget mismatch");
    for (const [index, ref] of preparation.intentRefs.entries()) {
      const t = IntentTemplate.parse(await sink.read(ref)),
        slot = slots[index]!;
      if (
        !MutationTools.safeParse(t.tool).success ||
        ToolCapability[MutationTools.parse(t.tool)] !== t.capability ||
        t.sampleId !== slot.sampleId ||
        t.slotId !== slot.slotId ||
        t.capability !== slot.capability ||
        !originalAuthorization.capabilities.includes(t.capability) ||
        t.declaredBytes > slot.maxBodyBytes ||
        t.allocationHash !== identityHash("preparation", p, canonicalize)
      )
        throw new Error("intent binding mismatch");
    }
  }
  if (
    manifest.resultName === basename(path) ||
    [
      manifest.authorization,
      manifest.deploymentReceipt,
      manifest.deploymentExclusionEvidence,
      ...("preparation" in manifest ? [manifest.preparation] : []),
    ].some((r) => r.name === manifest.resultName)
  )
    throw new Error("result path aliases an input");
  return { manifest, manifestHash: digest(bytes), directory, sink, authorization, receipt, exclusion, preparation };
}
export type LocalPreflightV2 = Awaited<ReturnType<typeof preflightV2>>;
