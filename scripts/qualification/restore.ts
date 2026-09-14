import { randomBytes } from "node:crypto";
import { z } from "zod";
import { hash } from "./manifest.ts";
const restoreSchema = z
  .object({
    databaseId: z.string().uuid(),
    bookmark: z.string().regex(/^[A-Za-z0-9:_-]{1,256}$/),
    authorizationExpiresAt: z.number().int(),
    compatibilityVersion: z.literal(3),
  })
  .strict();
export interface RestorePort {
  maintenance(generation: string): Promise<void>;
  verifyFrozen(generation: string): Promise<void>;
  drained(): Promise<boolean>;
  exportJournal(): Promise<{ sha256: string; operations: number; keys: number }>;
  write(receipt: unknown): Promise<void>;
  restore(databaseId: string, bookmark: string): Promise<void>;
  installFrozen(generation: string): Promise<void>;
}
/** Caller holds exclusive deployment control. There is deliberately no resume operation in Phase A. */
export async function quarantineRestore(
  input: z.infer<typeof restoreSchema>,
  port: RestorePort,
): Promise<{ state: "quarantined"; generation: string }> {
  const m = restoreSchema.parse(input);
  if (m.authorizationExpiresAt <= Date.now()) throw new Error("restore authorization expired");
  const generation = "restore_" + randomBytes(32).toString("base64url");
  await port.maintenance(generation);
  await port.verifyFrozen(generation);
  if (!(await port.drained())) throw new Error("verifiable writer quiescence required; maintenance retained");
  const journal = z
    .object({ sha256: hash, operations: z.number().int().nonnegative(), keys: z.number().int().nonnegative() })
    .strict()
    .parse(await port.exportJournal());
  await port.write({ version: 1, state: "prepared", generation, journal, recorded_at: Date.now() });
  await port.verifyFrozen(generation);
  if (m.authorizationExpiresAt <= Date.now() || !(await port.drained()))
    throw new Error("restore preconditions changed; maintenance retained");
  await port.restore(m.databaseId, m.bookmark);
  // Restored active flags and absent keys never grant permission to resume mutation traffic.
  await port.installFrozen(generation);
  await port.verifyFrozen(generation);
  await port.write({ version: 1, state: "quarantined", generation, recorded_at: Date.now() });
  return { state: "quarantined", generation };
}
