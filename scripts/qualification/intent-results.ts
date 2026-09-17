import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { canonicalize } from "../../worker/src/crypto/canonical.ts";
import { ArtifactRef, Consumption, assertSameConsumption, parsePrivateArtifact } from "./contracts.ts";
import { IntentResultProjection } from "./intent-resolution.ts";
import { openIntentJournal } from "./intent-store.ts";
import { digest, privateDirectory, readPrivateBytes, writePrivateJson } from "./private-files.ts";

export interface SealedIntentResult {
  ref: z.infer<typeof ArtifactRef>;
  projection: z.infer<typeof IntentResultProjection>;
}
export interface IntentResults {
  read(slotId: string): Promise<SealedIntentResult | null>;
  seal(projection: unknown): Promise<SealedIntentResult>;
}
/** Only trusted transport adapters may publish projections; consumption alone does not prove success. */
export async function openIntentResults(
  authorizationId: string,
  preparationCommitment: string,
  storeRoot = join(homedir(), ".gmail-mcp-qualification-intents"),
): Promise<IntentResults> {
  const journal = await openIntentJournal(authorizationId, preparationCommitment, storeRoot);
  const root = await privateDirectory(storeRoot);
  const nameOf = (slotId: string) =>
    `result-${digest(canonicalize([authorizationId, Consumption.shape.slotId.parse(slotId)]))}.json`;
  const verify = async (projection: z.infer<typeof IntentResultProjection>) => {
    if (
      projection.consumption.authorizationId !== authorizationId ||
      projection.consumption.preparationCommitment !== preparationCommitment
    )
      throw new Error("preparation binding mismatch");
    const consumed = await journal.readConsumption(projection.consumption.slotId);
    if (!consumed) throw new Error("preparation_incomplete");
    assertSameConsumption(projection.consumption, consumed, canonicalize);
  };
  const results: IntentResults = {
    read: async (slotId) => {
      const name = nameOf(slotId);
      // Verify the host binding even when no result file exists.
      await journal.readConsumption(slotId);
      let bytes: Buffer;
      try {
        bytes = await readPrivateBytes(join(root, name));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
      const projection = IntentResultProjection.parse(parsePrivateArtifact(bytes));
      if (projection.consumption.slotId !== slotId) throw new Error("preparation binding mismatch");
      await verify(projection);
      return { ref: { name, sha256: digest(bytes) }, projection };
    },
    seal: async (input) => {
      const projection = IntentResultProjection.parse(input);
      await verify(projection);
      const name = nameOf(projection.consumption.slotId);
      try {
        await writePrivateJson(root, name, projection);
      } catch {
        // A sync error after publication must retain the first result, just as a lost provider receipt spends its slot.
        const prior = await results.read(projection.consumption.slotId);
        if (!prior || canonicalize(prior.projection) !== canonicalize(projection))
          throw new Error("result already sealed");
      }
      const sealed = await results.read(projection.consumption.slotId);
      if (!sealed || canonicalize(sealed.projection) !== canonicalize(projection)) throw new Error("invalid_evidence");
      return sealed;
    },
  };
  return results;
}
