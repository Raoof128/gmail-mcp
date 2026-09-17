import { canonicalize } from "../../worker/src/crypto/canonical.ts";
import { Authorization, Target, identityHash, snapshotOf } from "./contracts.ts";
import { DeploymentReceiptV2 } from "./preflight-v2.ts";
import { verifyDeployment, type Api } from "./platform.ts";

/**
 * Read-only deployment/account verification for v2 callers. This supplies neither writer exclusion
 * nor bundle provenance: an ETag-bound receipt still requires the separate reproducible build gate.
 */
export async function verifyTargetV2(options: {
  target: unknown;
  authorization: unknown;
  receipt: unknown;
  api: Api;
  transport?: typeof fetch;
  now?: () => number;
}): Promise<void> {
  const target = Target.parse(options.target);
  const authorization = Authorization.parse(options.authorization);
  const receipt = DeploymentReceiptV2.parse(options.receipt);
  const now = options.now ?? Date.now;
  const verifyTime = () => {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0 || time >= authorization.expiresAt) throw new Error("intent_expired");
  };
  if (
    authorization.targetHash !== identityHash("target", target, canonicalize) ||
    canonicalize(receipt.snapshot) !== canonicalize(snapshotOf(target))
  )
    throw new Error("identity_drift");
  verifyTime();
  // Share the existing authoritative platform queries without manufacturing a legacy exclusion boolean.
  await verifyDeployment(
    { ...target, authorization: { sender: authorization.sender } },
    {
      version: 1,
      workerBuildId: target.workerBuildId,
      deploymentVersionId: target.deploymentVersionId,
      deploymentId: target.deploymentId,
      restoreGeneration: target.restoreGeneration,
      compatibilityVersion: target.compatibilityVersion,
      configSha256: target.configSha256,
      schemaSha256: target.schemaSha256,
      bundleSha256: receipt.bundleSha256,
      platformScriptEtag: receipt.platformScriptEtag,
    },
    options.api,
    options.transport,
  );
  verifyTime();
}
