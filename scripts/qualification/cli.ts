import { z } from "zod";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "../../worker/src/crypto/canonical.ts";
import { Hash, Reason, ManifestV2 } from "./contracts.ts";
import { EvidenceVerifier } from "./contracts-validation.ts";
import { preflightV2, type LocalPreflightV2, type V2Command } from "./preflight-v2.ts";
import { RunReportV2, selectRunCase } from "./run-v2.ts";
export const CommandStatus = z
  .object({
    version: z.literal(2),
    kind: z.literal("command-status"),
    command: z.enum(["prepare", "probe", "run", "enable", "disable"]),
    manifestSha256: Hash,
    result: z.literal("not_run"),
    limitation: Reason,
  })
  .strict();
export interface CommandPorts {
  now?: () => number;
  /** Installed code must verify the actual target and exclusion, not parse a caller's boolean. */
  verifyLiveTargetAndExclusion(local: LocalPreflightV2): Promise<void>;
  run?: (local: LocalPreflightV2) => Promise<z.infer<typeof RunReportV2>>;
}
export async function executeV2(local: LocalPreflightV2, ports?: CommandPorts): Promise<number> {
  const manifest = ManifestV2.parse(local.manifest);
  const manifestHash = local.manifestHash;
  const expiresAt = local.authorization.expiresAt;
  const sink = Object.freeze({ read: local.sink.read.bind(local.sink), write: local.sink.write.bind(local.sink) });
  const unavailable = async (limitation: z.infer<typeof Reason>) => {
    await sink.write(
      `command-${randomUUID()}.json`,
      CommandStatus.parse({
        version: 2,
        kind: "command-status",
        command: manifest.phase,
        manifestSha256: manifestHash,
        result: "not_run",
        limitation,
      }),
    );
    return 1;
  };
  // There is no default live mechanism. Refusal precedes credential access and controller dispatch.
  if (!ports) return unavailable("deployment_exclusion_unavailable");
  const now = ports.now ?? Date.now;
  if (!Number.isSafeInteger(now()) || now() >= expiresAt) return unavailable("intent_expired");
  try {
    await ports.verifyLiveTargetAndExclusion(local);
  } catch {
    return unavailable("deployment_exclusion_unavailable");
  }
  if (!Number.isSafeInteger(now()) || now() >= expiresAt) return unavailable("intent_expired");
  if (manifest.phase !== "run" || !ports.run) return unavailable("missing_adapter");
  let report = RunReportV2.parse(await ports.run(local));
  if (
    report.identity.startedAt > now() ||
    report.identity.manifestSha256 !== manifestHash ||
    report.identity.purpose !== manifest.purpose ||
    canonicalize(report.identity.target) !== canonicalize(manifest.target) ||
    report.identity.preparationCommitment !== manifest.preparationCommitment ||
    (manifest.purpose === "recovery-mode" &&
      (report.identity.mode !== manifest.mode ||
        report.identity.qualificationEpoch !== manifest.expectedEpoch ||
        report.identity.preparationRoot !== manifest.preparationRoot)) ||
    canonicalize(report.identity) !== canonicalize(report.report.identity) ||
    report.report.caseId !== selectRunCase(report.identity, manifest.caseIds) ||
    report.exitCode !== (report.report.result === "pass" ? 0 : 1)
  )
    throw new Error("run identity mismatch");
  if (report.report.result === "pass") await new EvidenceVerifier().validateCase(report.report, sink, report.identity);
  let lateFailure: "intent_expired" | "identity_drift" | null = null;
  if (!Number.isSafeInteger(now()) || now() >= expiresAt) lateFailure = "intent_expired";
  else {
    try {
      await ports.verifyLiveTargetAndExclusion(local);
    } catch {
      lateFailure = "identity_drift";
    }
  }
  if (lateFailure !== null && report.report.result !== "fail") {
    report = RunReportV2.parse({
      ...report,
      exitCode: 1,
      report: { ...report.report, result: "fail", limitation: lateFailure },
    });
  }
  // Publish both a source-verifiable CaseReport and its enclosing run result without replacement.
  await sink.write(`case-${report.identity.runId}.json`, report.report);
  await sink.write(manifest.resultName, report);
  return report.exitCode;
}
export async function main(args: string[]): Promise<number> {
  if (args.length === 4 && args[0] === "run" && args[3] === "--synthetic") {
    const legacy = await import("./legacy-cli.ts");
    return legacy.main(args);
  }
  const [command, flag, path, ...extra] = args;
  if (
    !command ||
    !["prepare", "probe", "run", "enable", "disable"].includes(command) ||
    flag !== "--manifest" ||
    !path ||
    extra.length
  )
    throw new Error("usage: command --manifest private-path");
  const local = await preflightV2(path, command as V2Command);
  return executeV2(local);
}
export function invokedAs(url: string): boolean {
  return Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url));
}
export async function entry(args: string[]): Promise<void> {
  try {
    process.exitCode = await main(args);
  } catch {
    process.stderr.write("qualification command failed; inspect private evidence before retrying\n");
    process.exitCode = 1;
  }
}
if (invokedAs(import.meta.url)) await entry(process.argv.slice(2));
