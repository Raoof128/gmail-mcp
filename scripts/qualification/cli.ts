import { artifactSchema } from "./artifacts.ts";
import { caseRegistry } from "./cases/index.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { abandonStorage } from "./storage.ts";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preflight } from "./preflight.ts";
import { withDeploymentLock } from "./lock.ts";
import { changeQualification, type Command } from "./admin.ts";
import { d1Batch, platformApi, verifyDeployment, verifyQualification } from "./platform.ts";
import { loadEnableEvidence } from "./evidence.ts";
import { writePrivateJson } from "./private-files.ts";
import { runCases, type RunIdentity } from "./run.ts";
export async function main(args: string[]): Promise<number> {
  // Arguments never accept credentials, SQL, arbitrary URLs or shell commands.
  const [command, flag, path, ...extra] = args;
  if (
    !command ||
    !["probe", "enable", "disable", "run", "abandon-storage"].includes(command) ||
    flag !== "--manifest" ||
    !path ||
    (extra.length > 0 && !(command === "run" && extra.length === 1 && extra[0] === "--synthetic"))
  )
    throw new Error("usage: command --manifest private-path [--synthetic]");
  const { manifest: m, receipt, directory, manifestHash } = await preflight(path);
  if (command === "probe" && (m.profile !== "scratch" || !m.probeIds.length))
    throw new Error("scratch probe manifest required");
  const synthetic = extra[0] === "--synthetic";
  const evidence = command === "enable" ? await loadEnableEvidence(m, manifestHash) : undefined;
  return withDeploymentLock(m, async () => {
    // Local preflight and evidence refusal occur before credential access.
    const api = synthetic ? null : platformApi(process.env.CLOUDFLARE_API_TOKEN ?? "");
    const verify = async () => {
      if (api) {
        await verifyDeployment(m, receipt, api);
        if (command === "run") await verifyQualification(m, api);
      }
    };
    if (command === "run") {
      if (!m.expectedEpoch || !m.runResult || resolve(m.runResult) !== resolve(directory, basename(m.runResult)))
        throw new Error("run epoch and result path required");
      const identity: RunIdentity = {
        runId: randomUUID(),
        deploymentVersionId: m.deploymentVersionId,
        workerBuildId: m.workerBuildId,
        qualificationEpoch: m.expectedEpoch,
        restoreGeneration: m.restoreGeneration,
        manifestSha256: manifestHash,
        startedAt: Date.now(),
        ...(receipt.companionBuildId ? { companionBuildId: receipt.companionBuildId } : {}),
        ...(receipt.nativeBuildId ? { nativeBuildId: receipt.nativeBuildId } : {}),
      };
      const cases = caseRegistry({
        manifest: m,
        synthetic,
        local: async (files, run, caseId) => {
          try {
            const result = await promisify(execFile)(
              "npm",
              ["test", "-w", "@gmail-mcp/worker", "--", "--run", ...files.map((f) => `test/${f}`)],
              {
                cwd: fileURLToPath(new URL("../../", import.meta.url)),
                timeout: 120000,
                maxBuffer: 1048576,
                env: { ...process.env, NO_COLOR: "1", CI: "1" },
              },
            );
            const passed = Number(/Tests\s+(\d+) passed/.exec(result.stdout)?.[1] ?? 0);
            if (!passed) throw new Error("test summary missing");
            const artifact = await writePrivateJson(
              directory,
              `${run.runId}-${caseId}-artifact.json`,
              artifactSchema.parse({
                version: 1,
                mode: "synthetic",
                run_id: run.runId,
                case_id: caseId,
                manifest_sha256: run.manifestSha256,
                worker_build: run.workerBuildId,
                tests: files,
                passed,
              }),
            );
            return { result: "pass", attempts: 1, artifact_sha256: artifact, limitation: null };
          } catch {
            return { result: "fail", attempts: 1, artifact_sha256: null, limitation: "case_failed" };
          }
        },
      }).filter((c) => m.caseIds.includes(c.id));
      const report = await runCases(identity, synthetic ? "synthetic" : "live", cases, {
        verify,
        write: async (row) => {
          await writePrivateJson(directory, `${identity.runId}-${row.case_id}.json`, row);
        },
      });
      await writePrivateJson(directory, basename(m.runResult), report);
      return report.exitCode;
    }
    if (command === "abandon-storage") {
      if (!m.stagingBucket || !m.storageIntent || !m.operationId) throw new Error("storage scope required");
      await writePrivateJson(directory, `storage-intent-${randomUUID()}.json`, {
        version: 1,
        intent_sha256: manifestHash,
        recorded_at: Date.now(),
      });
      const configName = `r2-config-${randomUUID()}.json`;
      await writePrivateJson(directory, configName, { account_id: m.platformAccountId });
      const result = await abandonStorage(m, manifestHash, {
        verify,
        batch: async (stmts) => {
          await d1Batch(m, api!, stmts);
        },
        select: async (stmt) => (await d1Batch(m, api!, [stmt]))[0]!,
        remove: async (key) => {
          if (!/^stg\/[A-Za-z0-9_./-]{1,2048}$/.test(key) || key.includes(".."))
            throw new Error("object scope refused");
          await promisify(execFile)(
            process.execPath,
            [
              fileURLToPath(new URL("../../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
              "r2",
              "object",
              "delete",
              `${m.stagingBucket}/${key}`,
              "--remote",
              "--config",
              resolve(directory, configName),
            ],
            {
              cwd: directory,
              timeout: 30000,
              maxBuffer: 65536,
              env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                TMPDIR: process.env.TMPDIR,
                CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
                CLOUDFLARE_ACCOUNT_ID: m.platformAccountId,
                WRANGLER_SEND_METRICS: "false",
                CI: "1",
              },
            },
          );
        },
      });
      await writePrivateJson(directory, `storage-result-${randomUUID()}.json`, result);
      return 0;
    }
    const result = await changeQualification(
      command as Command,
      m,
      manifestHash,
      {
        verify,
        batch: async (stmts) => {
          await d1Batch(m, api!, stmts);
        },
      },
      evidence,
    );
    await writePrivateJson(directory, `admin-${randomUUID()}.json`, {
      version: 1,
      command,
      epoch: result.epoch,
      intent_sha256: manifestHash,
      parent_run_id: evidence?.runId ?? null,
      parent_epoch: evidence?.qualificationEpoch ?? null,
    });
    return 0;
  }).catch(async () => {
    await writePrivateJson(directory, `command-failed-${randomUUID()}.json`, {
      version: 1,
      command,
      intent_sha256: manifestHash,
      result: "fail",
      remote_state: "unverified",
      recorded_at: Date.now(),
    }).catch(() => undefined);
    throw new Error("qualification command failed");
  });
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
