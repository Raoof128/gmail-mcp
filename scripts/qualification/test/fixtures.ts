import type { Manifest } from "../manifest.ts";
import { caseIds } from "../manifest.ts";
export function fixtureManifest(): Manifest {
  return {
    version: 1,
    origin: "https://worker.example",
    workerName: "worker",
    platformAccountId: "a".repeat(32),
    databaseId: "11111111-1111-4111-8111-111111111111",
    userId: "owner",
    accountId: "account",
    credentialVersion: 1,
    mode: "generated_search",
    profile: "normal",
    workerBuildId: "b".repeat(64),
    deploymentVersionId: "22222222-2222-4222-8222-222222222222",
    deploymentId: "33333333-3333-4333-8333-333333333333",
    restoreGeneration: "generation",
    expectedEpoch: null,
    probeIds: [],
    privateDirectory: "/private/evidence",
    deploymentReceipt: "/private/evidence/deployment.json",
    caseIds: [...caseIds],
    exclusiveDeploymentControl: true,
  };
}
