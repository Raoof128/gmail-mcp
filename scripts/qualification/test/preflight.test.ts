import { expect, it } from "vitest";
import { mkdtemp, writeFile, chmod, symlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "../private-files.ts";
import { manifestSchema } from "../manifest.ts";
it("refuses symlinks, exposed files and unsafe roots before reading credentials", async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "qualification-"));
  await chmod(dir, 0o700);
  try {
    const path = join(dir, "manifest.json");
    await writeFile(path, "{}", { mode: 0o644 });
    await expect(readPrivateJson(path)).rejects.toThrow();
    await chmod(path, 0o600);
    expect(await readPrivateJson(path)).toEqual({});
    await symlink(path, join(dir, "link"));
    await expect(readPrivateJson(join(dir, "link"))).rejects.toThrow();
    await expect(writePrivateJson(dir, "case.json", { case_id: "one", result: "pass" })).resolves.toMatch(
      /^[a-f0-9]{64}$/,
    );
    await expect(writePrivateJson(dir, "case.json", { case_id: "one", result: "fail" })).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("rejects an incomplete/extra-field manifest", () => {
  expect(manifestSchema.safeParse({ origin: "http://evil.test", token: "secret" }).success).toBe(false);
});
it("publishes exactly one result when writers race", async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "qualification-"));
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => writePrivateJson(dir, "race.json", { i })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("refuses a private child beneath a writable non-sticky parent", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "unsafe-parent-"));
  const { mkdir } = await import("node:fs/promises");
  try {
    await mkdir(join(root, "private"), { mode: 0o700 });
    await chmod(root, 0o777);
    await expect(writePrivateJson(join(root, "private"), "refused.json", {})).rejects.toThrow();
  } finally {
    await chmod(root, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});
it("refuses synthetic, incomplete, or unsafe artifacts for live enable", async () => {
  const { validateLiveArtifact } = await import("../artifacts.ts");
  const common = {
    version: 1,
    run_id: "11111111-1111-4111-8111-111111111111",
    case_id: "generated-id",
    manifest_sha256: "a".repeat(64),
    worker_build: "b".repeat(64),
  };
  expect(() =>
    validateLiveArtifact({ ...common, mode: "synthetic", tests: ["reconcile.test.ts"], passed: 3 }),
  ).toThrow();
  expect(() => validateLiveArtifact({ ...common, mode: "live", metrics: { samples: 3 } })).toThrow();
  const metrics = {
    samples: 3,
    exact_matches: 3,
    replays: 3,
    duplicates: 0,
    false_confirmations: 0,
    unexpected_recipients: 0,
    credential_leaks: 0,
    overwrites: 0,
    resource_errors: 0,
  };
  expect(() => validateLiveArtifact({ ...common, mode: "live", metrics })).not.toThrow();
  expect(() => validateLiveArtifact({ ...common, mode: "live", metrics: { ...metrics, duplicates: 1 } })).toThrow();
  expect(() => validateLiveArtifact({ ...common, mode: "live", metrics, session_uri: "secret" })).toThrow();
});
