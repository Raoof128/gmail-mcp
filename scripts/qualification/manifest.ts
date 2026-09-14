import { z } from "zod";
export const caseIds = [
  "generated-id",
  "session-status",
  "draft-negative",
  "byte-round-trip",
  "media-boundary",
  "reply-revoke",
  "installed-clients",
  "native",
  "physical-durability",
  "resources",
  "rollback",
] as const;
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const manifestSchema = z
  .object({
    version: z.literal(1),
    origin: z
      .string()
      .url()
      .refine((v) => {
        const u = new URL(v);
        return u.protocol === "https:" && u.origin === v;
      }),
    workerName: id,
    platformAccountId: z.string().regex(/^[a-f0-9]{32}$/),
    databaseId: z.string().uuid(),
    userId: id,
    accountId: id,
    accountAlias: id.optional(),
    credentialVersion: z.number().int().nonnegative(),
    mode: z.enum(["generated_search", "send_session_status"]),
    profile: z.enum(["normal", "scratch"]),
    workerBuildId: hash,
    deploymentVersionId: z.string().uuid(),
    deploymentId: z.string().uuid(),
    restoreGeneration: id,
    expectedEpoch: z
      .string()
      .regex(/^qe_[A-Za-z0-9_-]{43}$/)
      .nullable(),
    probeIds: z.array(id).max(20),
    privateDirectory: z.string().min(1),
    deploymentReceipt: z.string().min(1),
    caseIds: z.array(z.enum(caseIds)).min(1),
    exclusiveDeploymentControl: z.literal(true),
    authorization: z
      .object({
        sender: z.string().email(),
        recipient: z.string().email(),
        expiresAt: z.number().int(),
        capabilities: z.array(z.enum(["send", "revoke", "restore", "power-loss"])),
        reference: id,
      })
      .strict()
      .optional(),
    runResult: z.string().optional(),
    operationId: id.optional(),
    stagingBucket: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/)
      .optional(),
    storageIntent: z
      .object({ handles: z.array(id).min(1).max(20), reference: id, expiresAt: z.number().int() })
      .strict()
      .optional(),
  })
  .strict()
  .refine((m) => new Set(m.caseIds).size === m.caseIds.length && new Set(m.probeIds).size === m.probeIds.length);
export type Manifest = z.infer<typeof manifestSchema>;
export const receiptSchema = z
  .object({
    version: z.literal(1),
    workerBuildId: hash,
    deploymentVersionId: z.string().uuid(),
    deploymentId: z.string().uuid(),
    bundleSha256: hash,
    platformScriptEtag: z.string().min(1).max(256),
    compatibilityVersion: z.literal(3),
    schemaSha256: hash,
    configSha256: hash,
    restoreGeneration: id,
    companionBuildId: hash.optional(),
    nativeBuildId: hash.optional(),
  })
  .strict();
export type DeploymentReceipt = z.infer<typeof receiptSchema>;
