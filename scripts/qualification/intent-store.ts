import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { canonicalize } from "../../worker/src/crypto/canonical.ts";
import {
  Consumption,
  Hash,
  PreparationOutcome,
  PreparationSource,
  assertSameConsumption,
  type IntentStore,
} from "./contracts.ts";
import { createPrivateSink, digest, privateDirectory, readPrivateJson, writePrivateJson } from "./private-files.ts";

const Binding = z.object({ authorizationId: z.string().uuid(), preparationCommitment: Hash }).strict();
/** The namespace is host-wide, never selected by a manifest's evidence directory. */
export async function createIntentStore(
  authorizationId: string,
  preparationCommitment: string,
  storeRoot = join(homedir(), ".gmail-mcp-qualification-intents"),
): Promise<DurableIntentStore> {
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
  const journal = await openIntentJournal(authorizationId, preparationCommitment, root);
  const store: DurableIntentStore = {
    ...journal,
    sealSample: async (sourceInput) => {
      const source = PreparationSource.parse(sourceInput);
      if (source.preparationCommitment !== preparationCommitment) throw new Error("preparation binding mismatch");
      // Pin the first source by sample before publishing its derived outcome.
      const name = `sample-${digest(canonicalize([authorizationId, source.sampleId]))}.json`;
      try {
        await writePrivateJson(root, name, source);
      } catch {
        const prior = PreparationSource.parse(
          await (await createPrivateSink(root)).read({ name, sha256: digest(JSON.stringify(source) + "\n") }),
        );
        if (canonicalize(prior) !== canonicalize(source)) throw new Error("source already sealed");
      }
      await store.appendOutcome(preparationCommitment, outcomeOf(source));
      const sealed = await journal.readSample(source.sampleId);
      if (!sealed) throw new Error("preparation_incomplete");
      return sealed;
    },
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
  return store;
}

export interface SealedSample {
  outcome: PreparationOutcome;
  source: z.infer<typeof PreparationSource>;
}
export interface IntentJournal {
  readonly binding: Readonly<z.infer<typeof Binding>>;
  readConsumption(slotId: string): Promise<Consumption | null>;
  readSample(sampleId: string): Promise<SealedSample | null>;
}
export interface DurableIntentStore extends IntentStore, IntentJournal {
  sealSample(source: z.infer<typeof PreparationSource>): Promise<SealedSample>;
}
function outcomeOf(source: z.infer<typeof PreparationSource>): PreparationOutcome {
  const states = {
    "barrier-ready": "ready",
    "component-ready": "ready",
    "sample-failed": "failed",
    "sample-uncertain": "uncertain",
    "sample-not-run": "not_run",
  } as const;
  return PreparationOutcome.parse({
    sampleId: source.sampleId,
    state: states[source.event],
    operationId: source.operationId,
    bindingSha256: source.bindingSha256,
    sourceSha256: digest(JSON.stringify(source) + "\n"),
    recordedAt: source.recordedAt,
    reason: source.reason,
  });
}
async function optionalRecord(path: string): Promise<{ value: unknown } | null> {
  try {
    return { value: await readPrivateJson(path) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
/** Opens only an existing host journal; reconciliation never creates authority or consumes a slot. */
export async function openIntentJournal(
  authorizationId: string,
  preparationCommitment: string,
  storeRoot = join(homedir(), ".gmail-mcp-qualification-intents"),
): Promise<IntentJournal> {
  const binding = Object.freeze(Binding.parse({ authorizationId, preparationCommitment }));
  const root = await privateDirectory(storeRoot);
  const verifyBinding = async () => {
    const actual = Binding.parse(await readPrivateJson(join(root, `authorization-${authorizationId}.json`)));
    if (canonicalize(actual) !== canonicalize(binding)) throw new Error("preparation binding mismatch");
  };
  await verifyBinding();
  return {
    binding,
    readConsumption: async (input) => {
      const slotId = Consumption.shape.slotId.parse(input);
      await verifyBinding();
      const value = await optionalRecord(join(root, `slot-${digest(canonicalize([authorizationId, slotId]))}.json`));
      if (value === null) return null;
      const record = Consumption.parse(value.value);
      if (
        record.authorizationId !== authorizationId ||
        record.preparationCommitment !== preparationCommitment ||
        record.slotId !== slotId
      )
        throw new Error("mutation binding mismatch");
      return record;
    },
    readSample: async (input) => {
      const sampleId = z.string().uuid().parse(input);
      await verifyBinding();
      const key = digest(canonicalize([authorizationId, sampleId]));
      const value = await optionalRecord(join(root, `outcome-${key}.json`));
      const checkpoint = await optionalRecord(join(root, `sample-${key}.json`));
      if (value === null && checkpoint === null) return null;
      if (checkpoint === null) throw new Error("preparation_incomplete");
      const pinned = PreparationSource.parse(checkpoint.value);
      // A crash between source and outcome publication preserves the source's first terminal truth.
      const outcome = value === null ? outcomeOf(pinned) : PreparationOutcome.parse(value.value);
      const source = PreparationSource.parse(
        await (await createPrivateSink(root)).read({ name: `sample-${key}.json`, sha256: outcome.sourceSha256 }),
      );
      if (
        outcome.sampleId !== sampleId ||
        source.preparationCommitment !== preparationCommitment ||
        canonicalize(outcomeOf(source)) !== canonicalize(outcome)
      )
        throw new Error("preparation binding mismatch");
      return { outcome, source };
    },
  };
}

/** Domain-separated root of an ordered journal with no consumed mutation slots. */
export const EMPTY_SLOT_JOURNAL_ROOT = digest("gmail-mcp/plan6/v2/slot-journal\n[]");
