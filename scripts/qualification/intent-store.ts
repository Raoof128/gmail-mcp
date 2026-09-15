import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { canonicalize } from "../../worker/src/crypto/canonical.ts";
import { Consumption, Hash, PreparationOutcome, assertSameConsumption, type IntentStore } from "./contracts.ts";
import { digest, privateDirectory, readPrivateJson, writePrivateJson } from "./private-files.ts";

const Binding = z.object({ authorizationId: z.string().uuid(), preparationCommitment: Hash }).strict();
/** The namespace is host-wide, never selected by a manifest's evidence directory. */
export async function createIntentStore(
  authorizationId: string,
  preparationCommitment: string,
  storeRoot = join(homedir(), ".gmail-mcp-qualification-intents"),
): Promise<IntentStore> {
  const binding = Binding.parse({ authorizationId, preparationCommitment });
  await mkdir(storeRoot, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
  const root = await privateDirectory(storeRoot);
  const bindingName = `authorization-${authorizationId}.json`;
  try {
    await writePrivateJson(root, bindingName, binding);
  } catch {
    // A persisted binding pins this authorization to one preparation, including after a crash.
    const prior = Binding.parse(await readPrivateJson(join(root, bindingName)));
    if (canonicalize(prior) !== canonicalize(binding)) throw new Error("authorization already bound");
  }
  return {
    consume: async (input) => {
      const request = Consumption.parse(input);
      if (request.authorizationId !== authorizationId || request.preparationCommitment !== preparationCommitment)
        throw new Error("mutation binding mismatch");
      const name = `slot-${digest(canonicalize([authorizationId, request.slotId]))}.json`;
      try {
        await writePrivateJson(root, name, request);
        return { status: "new", committed: request };
      } catch {
        // Even a publication followed by a sync error must never become another external call.
        const committed = Consumption.parse(await readPrivateJson(join(root, name)));
        assertSameConsumption(request, committed, canonicalize);
        return { status: "already-consumed", committed };
      }
    },
    appendOutcome: async (commitment, input) => {
      if (commitment !== preparationCommitment) throw new Error("preparation binding mismatch");
      const outcome = PreparationOutcome.parse(input);
      const name = `outcome-${digest(canonicalize([authorizationId, outcome.sampleId]))}.json`;
      try {
        return { name, sha256: await writePrivateJson(root, name, outcome) };
      } catch {
        const previous = PreparationOutcome.parse(await readPrivateJson(join(root, name)));
        if (canonicalize(previous) !== canonicalize(outcome)) throw new Error("outcome already sealed");
        return { name, sha256: digest(JSON.stringify(previous) + "\n") };
      }
    },
  };
}
