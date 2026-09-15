import { randomBytes } from "node:crypto";
import { manifestSchema, hash, type Manifest } from "./manifest.ts";
export type Statement = { sql: string; params: (string | number | null)[] };
/** The port must hold exclusive deployment control through both verification calls and the atomic batch. */
export interface AdminPort {
  verify(manifest: Manifest): Promise<void>;
  batch(statements: Statement[]): Promise<void>;
}
export type Command = "probe" | "enable" | "disable";
export interface EnableEvidence {
  version: 2;
  mode: "live";
  runId: string;
  runSha256: string;
  manifestSha256: string;
  qualificationEpoch: string;
  verify(manifest: Manifest): Promise<void>;
}
const key = "origin=? AND build_id=? AND user_id=? AND account_id=? AND credential_version=? AND mode=?";
export async function changeQualification(
  command: Command,
  input: Manifest,
  evidenceHash: string,
  port: AdminPort,
  evidence?: EnableEvidence,
): Promise<{ epoch: string }> {
  const m = manifestSchema.parse(input);
  hash.parse(evidenceHash);
  if (command === "probe" && (m.profile !== "scratch" || m.probeIds.length === 0))
    throw new Error("scratch probes required");
  if (
    command === "enable" &&
    (!evidence ||
      evidence.version !== 2 ||
      evidence.mode !== "live" ||
      evidence.manifestSha256 !== evidenceHash ||
      !m.expectedEpoch ||
      evidence.qualificationEpoch !== m.expectedEpoch)
  )
    throw new Error("sealed live evidence required");
  if (command === "enable") {
    hash.parse(evidence!.runSha256);
    await evidence!.verify(m);
  }
  await port.verify(m);
  const now = Date.now();
  const epoch = "qe_" + randomBytes(32).toString("base64url");
  const params = [m.origin, m.workerBuildId, m.userId, m.accountId, m.credentialVersion, m.mode];
  const assertion = (predicate: string, values: Statement["params"]): Statement => ({
    sql: `INSERT INTO _assert(x) SELECT 1 WHERE NOT (${predicate})`,
    params: values,
  });
  await port.batch([
    assertion(
      "EXISTS(SELECT 1 FROM recovery_installation WHERE singleton=1 AND schema_version=5 AND mutation_state='active' AND restore_generation=?)",
      [m.restoreGeneration],
    ),
    assertion("EXISTS(SELECT 1 FROM accounts WHERE user_id=? AND id=? AND status='active' AND credential_version=?)", [
      m.userId,
      m.accountId,
      m.credentialVersion,
    ]),
    m.expectedEpoch === null
      ? assertion(`NOT EXISTS(SELECT 1 FROM recovery_control WHERE ${key})`, params)
      : assertion(
          `EXISTS(SELECT 1 FROM recovery_control WHERE ${key} AND epoch=?${command === "enable" ? " AND expires_at>?" : ""})`,
          [...params, m.expectedEpoch, ...(command === "enable" ? [now] : [])],
        ),
    {
      sql: `DELETE FROM recovery_control WHERE (expires_at<=? OR state='disabled') AND NOT (${key})`,
      params: [now, ...params],
    },
    assertion(
      `EXISTS(SELECT 1 FROM recovery_control WHERE ${key}) OR ((SELECT count(*) FROM recovery_control WHERE user_id=?)<32 AND (SELECT count(*) FROM recovery_control)<64)`,
      [...params, m.userId],
    ),
    {
      sql: "INSERT INTO recovery_control(origin,build_id,user_id,account_id,credential_version,mode,state,epoch,expires_at,evidence_hash,probe_ids) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(origin,build_id,user_id,account_id,credential_version,mode) DO UPDATE SET state=excluded.state,epoch=excluded.epoch,expires_at=excluded.expires_at,evidence_hash=excluded.evidence_hash,probe_ids=excluded.probe_ids",
      params: [
        ...params,
        command === "probe" ? "probe" : command === "enable" ? "enabled" : "disabled",
        epoch,
        now + 604800000,
        command === "enable" ? evidence!.runSha256 : evidenceHash,
        JSON.stringify(command === "probe" ? m.probeIds : []),
      ],
    },
    ...(command === "disable"
      ? [
          {
            sql: "UPDATE operation_recovery SET session_enc=NULL,session_key_id=NULL,lease_token=NULL,lease_until=NULL,state=CASE WHEN state='completed' THEN state ELSE 'suspended' END WHERE user_id=? AND account_id=? AND credential_version=? AND json_extract(binding_json,'$.buildId')=? AND json_extract(binding_json,'$.origin')=?",
            params: [m.userId, m.accountId, m.credentialVersion, m.workerBuildId, m.origin],
          },
        ]
      : []),
  ]);
  try {
    await port.verify(m);
  } catch {
    if (command !== "disable") {
      // A failed post-write fence must not leave a new probe/enabled epoch usable.
      // Compare the exact epoch we wrote so another operator's edit is never overwritten.
      await port
        .batch([
          assertion(
            "EXISTS(SELECT 1 FROM recovery_installation WHERE singleton=1 AND schema_version=5 AND mutation_state='active' AND restore_generation=?)",
            [m.restoreGeneration],
          ),
          assertion(`EXISTS(SELECT 1 FROM recovery_control WHERE ${key} AND epoch=?)`, [...params, epoch]),
          {
            sql: `UPDATE recovery_control SET state='disabled',epoch=?,probe_ids='[]' WHERE ${key} AND epoch=?`,
            params: ["qe_" + randomBytes(32).toString("base64url"), ...params, epoch],
          },
          {
            sql: "UPDATE operation_recovery SET session_enc=NULL,session_key_id=NULL,lease_token=NULL,lease_until=NULL,state=CASE WHEN state='completed' THEN state ELSE 'suspended' END WHERE user_id=? AND account_id=? AND credential_version=? AND json_extract(binding_json,'$.buildId')=? AND json_extract(binding_json,'$.origin')=?",
            params: [m.userId, m.accountId, m.credentialVersion, m.workerBuildId, m.origin],
          },
        ])
        .catch(() => {
          throw new Error("deployment drift; containment unverified");
        });
    }
    throw new Error("deployment identity changed after administration");
  }
  return { epoch };
}

// Dynamic import keeps the callable transaction API independent from CLI startup.
if (process.argv[1]?.endsWith("/admin.ts")) {
  void import("./cli.ts").then(async ({ invokedAs, entry }) => {
    if (invokedAs(import.meta.url)) await entry(process.argv.slice(2));
  });
}
