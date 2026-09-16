import { z } from "zod";
import { canonicalize } from "../../../worker/src/crypto/canonical.ts";
import {
  ArtifactRef,
  Authorization,
  RestoreTarget,
  Target,
  Time,
  identityHash,
  snapshotOf,
  type PrivateSink,
} from "../contracts.ts";
import { QuiescenceVerifier } from "./quiescence.ts";

export const RestoreManifest = z
  .object({
    version: z.literal(2),
    purpose: z.literal("restore"),
    target: Target,
    restore: RestoreTarget,
    authorization: ArtifactRef,
  })
  .strict();

/** Local preparation only. No platform port is exposed while quiescence is unresolved. */
export async function prepareRestore(input: unknown, sink: PrivateSink, now: () => number = Date.now) {
  const manifest = RestoreManifest.parse(input);
  const auth = Authorization.parse(await sink.read(manifest.authorization));
  const target = manifest.restore;
  if (
    canonicalize(target.snapshot) !== canonicalize(snapshotOf(manifest.target)) ||
    auth.targetHash !== identityHash("target", manifest.target, canonicalize) ||
    target.authorizationSha256 !== identityHash("authorization", auth, canonicalize) ||
    target.authorizationExpiresAt > auth.expiresAt ||
    !auth.capabilities.includes("restore")
  )
    throw new Error("missing_authorization");
  const recordedAt = Time.parse(now());
  if (recordedAt >= target.authorizationExpiresAt) throw new Error("intent_expired");
  try {
    await new QuiescenceVerifier().verify(target);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "quiescence_unavailable") throw error;
    return {
      version: 2,
      state: "not_run",
      reason: "quiescence_unavailable",
      recordedAt,
      targetHash: identityHash("target", manifest.target, canonicalize),
    } as const;
  }
  // Adding a supported verifier must not silently activate an unreviewed restore implementation.
  throw new Error("restore_controller_unavailable");
}
