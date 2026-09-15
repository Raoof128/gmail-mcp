import type { Manifest } from "./manifest.ts";
import type { EnableEvidence } from "./admin.ts";
export { EvidenceVerifier, PreparationClosure, QualificationSource } from "./contracts-validation.ts";

/** Legacy aggregates remain readable as history, but can no longer produce enable authority. */
export function loadEnableEvidence(_manifest: Manifest, _manifestHash: string): Promise<EnableEvidence> {
  return Promise.reject(new Error("version-1 evidence cannot enable recovery; v2 admission required"));
}
