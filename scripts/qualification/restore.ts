/** Retired v1 entry point: a drained boolean never established writer quiescence. */
export async function quarantineRestore(_input: unknown, _port: unknown): Promise<never> {
  await Promise.resolve();
  throw new Error("version_1_restore_retired");
}
export { prepareRestore, RestoreManifest } from "./controllers/restore.ts";
