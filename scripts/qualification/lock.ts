import { constants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateDirectory, digest } from "./private-files.ts";
/** One host-wide lock per platform account/Worker. Evidence paths cannot create another lock namespace. */
export async function withDeploymentLock<T>(
  target: { platformAccountId: string; workerName: string },
  work: () => Promise<T>,
  lockRoot = join(homedir(), ".gmail-mcp-qualification-locks"),
): Promise<T> {
  await mkdir(lockRoot, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
  const root = await privateDirectory(lockRoot);
  const path = join(root, digest(JSON.stringify([target.platformAccountId, target.workerName])) + ".lock");
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(String(process.pid));
    await file.sync();
    return await work();
  } finally {
    await file.close();
    await unlink(path);
  }
}
