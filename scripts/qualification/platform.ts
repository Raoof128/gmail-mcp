import { z } from "zod";
import { canonicalConfig } from "./build-id.ts";
import { digest } from "./private-files.ts";
import { receiptSchema, type DeploymentReceipt, type Manifest } from "./manifest.ts";
import type { Statement } from "./admin.ts";
const refused = () => new Error("authoritative deployment verification refused");
export type Api = (path: string, body?: unknown) => Promise<unknown>;
/** Bounded through body EOF; raw platform error bodies never escape into evidence. */
export async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw refused();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 524288) throw refused();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    await reader.cancel().catch(() => undefined);
    throw refused();
  } finally {
    reader.releaseLock();
  }
}
export function platformApi(token: string, transport: typeof fetch = fetch): Api {
  if (!token || /\s/.test(token)) throw refused();
  return async (path, body) => {
    if (!/^\/accounts\/[a-f0-9]{32}\//.test(path) || path.includes("..") || path.includes("?")) throw refused();
    try {
      const response = await transport("https://api.cloudflare.com/client/v4" + path, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw refused();
      }
      const result = z.object({ success: z.literal(true), result: z.unknown() }).parse(await boundedJson(response));
      return result.result;
    } catch {
      throw refused();
    }
  };
}
export async function d1Batch(m: Manifest, api: Api, statements: Statement[]): Promise<unknown[][]> {
  const result = await api(`/accounts/${m.platformAccountId}/d1/database/${m.databaseId}/query`, { batch: statements });
  const rows = z.array(z.object({ success: z.literal(true), results: z.array(z.unknown()) })).parse(result);
  if (rows.length !== statements.length) throw refused();
  return rows.map((r) => r.results);
}
const deployments = z.object({
  deployments: z
    .array(
      z.object({
        id: z.string(),
        created_on: z.string().datetime({ offset: true }),
        versions: z.array(z.object({ version_id: z.string(), percentage: z.number() })),
      }),
    )
    .min(1),
});
const binding = z
  .object({ type: z.string(), name: z.string(), text: z.string().optional(), id: z.string().optional() })
  .passthrough();
export async function verifyDeployment(
  m: Manifest,
  receiptInput: DeploymentReceipt,
  api: Api,
  transport: typeof fetch = fetch,
): Promise<void> {
  const receipt = receiptSchema.parse(receiptInput);
  for (const field of ["workerBuildId", "deploymentVersionId", "deploymentId", "restoreGeneration"] as const)
    if (receipt[field] !== m[field]) throw refused();
  const base = `/accounts/${m.platformAccountId}/workers/scripts/${m.workerName}`;
  const active = deployments
    .parse(await api(base + "/deployments"))
    .deployments.sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0]!;
  if (
    active.id !== m.deploymentId ||
    active.versions.length !== 1 ||
    active.versions[0]!.percentage !== 100 ||
    active.versions[0]!.version_id !== m.deploymentVersionId
  )
    throw refused();
  const version = z
    .object({
      id: z.string(),
      resources: z.object({
        script: z.object({ etag: z.string() }),
        bindings: z.array(binding),
        script_runtime: z.record(z.string(), z.unknown()),
      }),
    })
    .parse(await api(base + "/versions/" + m.deploymentVersionId));
  if (version.id !== m.deploymentVersionId || version.resources.script.etag !== receipt.platformScriptEtag)
    throw refused();
  const bindings = version.resources.bindings;
  for (const [name, value] of [
    ["WORKER_HOSTNAME", new URL(m.origin).hostname],
    ["RECOVERY_PROFILE", m.profile],
    ["RESTORE_GENERATION", m.restoreGeneration],
  ])
    if (!bindings.some((b) => b.name === name && b.type === "plain_text" && b.text === value)) throw refused();
  if (!bindings.some((b) => b.name === "DB" && b.type === "d1" && b.id === m.databaseId)) throw refused();
  if (
    m.stagingBucket &&
    !bindings.some((b) => b.name === "STAGING" && b.type === "r2_bucket" && b.bucket_name === m.stagingBucket)
  )
    throw refused();
  if (deploymentConfigFingerprint(bindings, version.resources.script_runtime) !== receipt.configSha256) throw refused();
  const [schema, owner, installation] = await d1Batch(m, api, [
    {
      sql: "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name",
      params: [],
    },
    {
      sql: "SELECT credential_version,status,alias,google_email FROM accounts WHERE user_id=? AND id=?",
      params: [m.userId, m.accountId],
    },
    {
      sql: "SELECT schema_version,restore_generation,mutation_state FROM recovery_installation WHERE singleton=1",
      params: [],
    },
  ]);
  const schemaRows = z.array(z.object({ type: z.string(), name: z.string(), sql: z.string() })).parse(schema);
  if (
    digest(JSON.stringify(schemaRows)) !== receipt.schemaSha256 ||
    !["protocol2_update_permit", "protocol2_key_delete", "protocol2_staging_delete"].every((name) =>
      schemaRows.some((r) => r.name === name),
    )
  )
    throw refused();
  const account = z
    .array(
      z.object({ credential_version: z.number(), status: z.string(), alias: z.string(), google_email: z.string() }),
    )
    .length(1)
    .parse(owner)[0]!;
  const installed = z
    .array(
      z.object({ schema_version: z.literal(5), restore_generation: z.string(), mutation_state: z.literal("active") }),
    )
    .length(1)
    .parse(installation)[0]!;
  if (
    account.credential_version !== m.credentialVersion ||
    account.status !== "active" ||
    (m.accountAlias !== undefined && account.alias !== m.accountAlias) ||
    (m.authorization !== undefined && account.google_email !== m.authorization.sender) ||
    installed.restore_generation !== m.restoreGeneration
  )
    throw refused();
  const response = await transport(m.origin + "/healthz", { redirect: "error", signal: AbortSignal.timeout(15000) });
  if (
    response.headers.get("x-recovery-build") !== m.workerBuildId ||
    response.headers.get("x-recovery-version") !== m.deploymentVersionId ||
    !response.ok
  ) {
    await response.body?.cancel();
    throw refused();
  }
  z.object({ status: z.literal("ready") })
    .strict()
    .parse(await boundedJson(response));
}
/** Frozen qualification identity is checked independently of deployment and account identity. */
export async function verifyQualification(m: Manifest, api: Api): Promise<void> {
  if (!m.expectedEpoch) throw refused();
  const [rows] = await d1Batch(m, api, [
    {
      sql: "SELECT epoch,state,expires_at,probe_ids FROM recovery_control WHERE origin=? AND build_id=? AND user_id=? AND account_id=? AND credential_version=? AND mode=?",
      params: [m.origin, m.workerBuildId, m.userId, m.accountId, m.credentialVersion, m.mode],
    },
  ]);
  const [row] = z
    .array(
      z.object({
        epoch: z.string(),
        state: z.enum(["probe", "enabled"]),
        expires_at: z.number(),
        probe_ids: z.string(),
      }),
    )
    .length(1)
    .parse(rows);
  if (!row || row.epoch !== m.expectedEpoch || row.expires_at <= Date.now()) throw refused();
  if (row.state === "probe") {
    if (m.profile !== "scratch") throw refused();
    const ids = z.array(z.string()).parse(JSON.parse(row.probe_ids));
    if (JSON.stringify([...ids].sort()) !== JSON.stringify([...m.probeIds].sort())) throw refused();
  }
}

export function deploymentConfigFingerprint(inputs: unknown, runtime: Record<string, unknown>): string {
  const bindings = z.array(binding).parse(inputs);
  for (const b of bindings) {
    if (b.type === "plain_text" && /SECRET|TOKEN|PASSWORD|KEKS|HMAC|CREDENTIAL/i.test(b.name)) throw refused();
  }
  const safe = bindings
    .map((b) => (b.type === "secret_text" ? { name: b.name, type: b.type } : b))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return digest(canonicalConfig({ bindings: safe, runtime }));
}
