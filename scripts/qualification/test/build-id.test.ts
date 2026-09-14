import { join } from "node:path";
import { expect, it } from "vitest";
import { hashInputs, canonicalConfig } from "../build-id.ts";
it("hashes sorted framed production inputs and effective nonsecret configuration", () => {
  const a = [
    { path: "worker/src/a.ts", bytes: Buffer.from("a") },
    { path: "worker/src/b.ts", bytes: Buffer.from("b") },
  ];
  expect(hashInputs(a)).toBe(hashInputs([...a].reverse()));
  expect(hashInputs(a)).not.toBe(hashInputs([{ ...a[0]!, bytes: Buffer.from("changed") }, a[1]!]));
  expect(
    canonicalConfig({ compatibility_date: "2026-09-01", vars: { BUILD_ID: "a", RECOVERY_PROFILE: "scratch" } }),
  ).toBe(canonicalConfig({ vars: { RECOVERY_PROFILE: "scratch", BUILD_ID: "b" }, compatibility_date: "2026-09-01" }));
  expect(() => canonicalConfig({ vars: { TOKEN_KEKS: "secret" } })).toThrow();
});
it("ignores docs drift but refuses dirty production input", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { computeBuildId } = await import("../build-id.ts");
  const root = await mkdtemp(join(tmpdir(), "build-id-"));
  const git = (args: string[]) => promisify(execFile)("git", args, { cwd: root });
  try {
    await mkdir(join(root, "worker/src"), { recursive: true });
    await writeFile(join(root, "worker/src/index.ts"), "export const value=1;\n");
    await writeFile(join(root, "README.md"), "first\n");
    await git(["init"]);
    await git(["add", "."]);
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
    const first = await computeBuildId(root, {});
    await writeFile(join(root, "README.md"), "docs only\n");
    expect(await computeBuildId(root, {})).toBe(first);
    await writeFile(join(root, "worker/src/index.ts"), "export const value=2;\n");
    await expect(computeBuildId(root, {})).rejects.toThrow("dirty production input");
    await git(["add", "worker/src/index.ts"]);
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "production"]);
    expect(await computeBuildId(root, {})).not.toBe(first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
