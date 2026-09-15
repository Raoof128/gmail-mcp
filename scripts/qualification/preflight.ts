import { parsePrivateArtifact } from "./contracts.ts";
import { resolve, dirname } from "node:path";
import { manifestSchema, receiptSchema } from "./manifest.ts";
import { digest, privateDirectory, readPrivateJson, readPrivateBytes } from "./private-files.ts";
export async function preflight(path: string) {
  const bytes = await readPrivateBytes(path);
  const input: unknown = parsePrivateArtifact(bytes);
  const manifest = manifestSchema.parse(input);
  const directory = await privateDirectory(manifest.privateDirectory);
  if (dirname(resolve(path)) !== directory || dirname(resolve(manifest.deploymentReceipt)) !== directory)
    throw new Error("one private evidence directory required");
  const receipt = receiptSchema.parse(await readPrivateJson(manifest.deploymentReceipt));
  for (const field of ["workerBuildId", "deploymentVersionId", "deploymentId", "restoreGeneration"] as const)
    if (receipt[field] !== manifest[field]) throw new Error("deployment receipt mismatch");
  if (manifest.profile !== "scratch" && manifest.probeIds.length > 0) throw new Error("probe profile refused");
  return { manifest, receipt, directory, manifestHash: digest(bytes) };
}
