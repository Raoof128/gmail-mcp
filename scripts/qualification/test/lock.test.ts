import { expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDeploymentLock } from "../lock.ts";
it("uses one lock per deployment regardless of evidence directory", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "deployment-lock-"));
  const target = { platformAccountId: "a".repeat(32), workerName: "worker" };
  try {
    await withDeploymentLock(
      target,
      async () => {
        await expect(withDeploymentLock(target, () => Promise.resolve(), root)).rejects.toThrow();
      },
      root,
    );
    await expect(withDeploymentLock(target, () => Promise.resolve(1), root)).resolves.toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
