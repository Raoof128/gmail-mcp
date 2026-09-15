import { expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIntentStore } from "../intent-store.ts";
const authorizationId = "11111111-1111-4111-8111-111111111111";
const commitment = "a".repeat(64);
const request = {
  authorizationId,
  preparationCommitment: commitment,
  sampleId: "22222222-2222-4222-8222-222222222222",
  slotId: "33333333-3333-4333-8333-333333333333",
  resolvedIntentSha256: "b".repeat(64),
  templateSha256: "c".repeat(64),
  argumentSha256: "d".repeat(64),
  declaredBytes: 10,
};
it("publishes one consumption across competing store instances and preserves exact hashes", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "qualification-intents-"));
  try {
    const stores = await Promise.all(
      Array.from({ length: 8 }, () => createIntentStore(authorizationId, commitment, directory)),
    );
    const results = await Promise.all(stores.map((store) => store.consume(request)));
    expect(results.filter((r) => r.status === "new")).toHaveLength(1);
    expect(results.every((r) => JSON.stringify(r.committed) === JSON.stringify(request))).toBe(true);
    const reopened = await createIntentStore(authorizationId, commitment, directory);
    expect((await reopened.consume(request)).status).toBe("already-consumed");
    await expect(reopened.consume({ ...request, argumentSha256: "e".repeat(64) })).rejects.toThrow();
    await expect(createIntentStore(authorizationId, "f".repeat(64), directory)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("keeps one consumed slot across OS processes", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const directory = await mkdtemp(join(await realpath(tmpdir()), "qualification-process-intents-"));
  try {
    const module = new URL("../intent-store.ts", import.meta.url).href;
    const script = `import { createIntentStore } from ${JSON.stringify(module)};
      const store = await createIntentStore(${JSON.stringify(authorizationId)}, ${JSON.stringify(commitment)}, ${JSON.stringify(directory)});
      process.stdout.write((await store.consume(${JSON.stringify(request)})).status);`;
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
          timeout: 10000,
          maxBuffer: 4096,
        }),
      ),
    );
    expect(results.filter((r) => r.stdout === "new")).toHaveLength(1);
    expect(results.filter((r) => r.stdout === "already-consumed")).toHaveLength(3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("never replaces the first terminal outcome after reopening", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "qualification-outcome-"));
  try {
    const store = await createIntentStore(authorizationId, commitment, directory);
    const failed = {
      sampleId: request.sampleId,
      state: "uncertain" as const,
      operationId: null,
      bindingSha256: null,
      sourceSha256: "a".repeat(64),
      recordedAt: 100,
      reason: "ambiguous_mutation" as const,
    };
    const ref = await store.appendOutcome(commitment, failed);
    const reopened = await createIntentStore(authorizationId, commitment, directory);
    await expect(reopened.appendOutcome(commitment, failed)).resolves.toEqual(ref);
    await expect(reopened.appendOutcome(commitment, { ...failed, state: "ready", reason: null })).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
