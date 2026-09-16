import { z } from "zod";
import { canonicalize } from "../../../worker/src/crypto/canonical.ts";
import {
  Authorization,
  PreparationIdentity,
  RunIdentity,
  identityHash,
  type Controller,
  type Observation,
} from "../contracts.ts";
import { importDeviceObservation } from "./device-observations.ts";

const Case = z.enum(["installed-clients", "native", "physical-durability"]);
const required = {
  "installed-clients": "send",
  native: "native-session",
  "physical-durability": "power-loss",
} as const;
/** Imports individually attributed records; operators perform device actions through separately authorized procedures. */
export function createDeviceController(caseInput: z.infer<typeof Case>, pathsInput: string[]): Controller {
  const caseId = Case.parse(caseInput);
  const paths = Object.freeze(z.array(z.string().min(1).max(4096)).max(128).parse(pathsInput));
  return async (context) => {
    const observations: Observation[] = [];
    const identity = RunIdentity.parse(context.identity);
    const preparation = PreparationIdentity.parse(context.preparation);
    const authorization = Authorization.parse(context.authorization);
    if (
      !authorization.capabilities.includes(required[caseId]) ||
      identity.purpose !== "release-component" ||
      preparation.purpose !== "release-component" ||
      canonicalize(preparation.target) !== canonicalize(identity.target) ||
      authorization.targetHash !== identityHash("target", preparation.target, canonicalize) ||
      preparation.authorizationSha256 !== identityHash("authorization", authorization, canonicalize) ||
      preparation.allocations.some((a) => a.caseId !== caseId)
    )
      return { observations, limitation: "missing_authorization" };
    if (!paths.length) return { observations, limitation: "operator_required" };
    if (paths.length !== preparation.allocations.length) return { observations, limitation: "preparation_incomplete" };
    const expiry = Math.min(preparation.expiresAt, authorization.expiresAt);
    const validTime = () => {
      const now = context.now();
      return Number.isSafeInteger(now) && now >= Math.max(preparation.createdAt, identity.startedAt) && now < expiry;
    };
    for (const [index, path] of paths.entries()) {
      if (!validTime()) return { observations, limitation: "intent_expired" };
      try {
        await context.verifyTarget();
      } catch {
        return { observations, limitation: "identity_drift" };
      }
      try {
        const row = await importDeviceObservation(path, identity);
        if (
          row.details.caseId !== caseId ||
          row.sampleId !== preparation.allocations[index]!.sampleId ||
          row.recordedAt >= expiry ||
          row.recordedAt > context.now()
        )
          throw new Error("invalid_evidence");
        // The finalizer must resolve the same exact source in its own evidence namespace.
        await context.sink.read({ name: `source-${row.sourceSha256}.json`, sha256: row.sourceSha256 });
        observations.push(row);
        if (Object.values(row.safety).some((n) => n !== 0)) return { observations, limitation: "safety_stop" };
      } catch {
        return { observations, limitation: "invalid_evidence" };
      }
    }
    if (!validTime()) return { observations, limitation: "intent_expired" };
    try {
      await context.verifyTarget();
    } catch {
      return { observations, limitation: "identity_drift" };
    }
    return { observations, limitation: null };
  };
}
