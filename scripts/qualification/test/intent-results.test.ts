import { expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIntentStore } from "../intent-store.ts";
import { openIntentResults } from "../intent-results.ts";
const authorizationId = "11111111-1111-4111-8111-111111111111";
const commitment = "a".repeat(64);
const consumption = {
  authorizationId,
  preparationCommitment: commitment,
  sampleId: "22222222-2222-4222-8222-222222222222",
  slotId: "33333333-3333-4333-8333-333333333333",
  resolvedIntentSha256: "b".repeat(64),
  templateSha256: "c".repeat(64),
  argumentSha256: "d".repeat(64),
  declaredBytes: 10,
};
const projection = {
  version: 2,
  consumption,
  tool: "staging_upload",
  targetHash: "e".repeat(64),
  recordedAt: 200,
  fields: { handle: "captured" },
};
it("seals only consumed results and preserves the first result across competing writers and restart", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "qualification-results-"));
  try {
    const store = await createIntentStore(authorizationId, commitment, root);
    const results = await openIntentResults(authorizationId, commitment, root);
    expect(await results.read(consumption.slotId)).toBeNull();
    await expect(results.seal(projection)).rejects.toThrow();
    await store.consume(consumption);
    const outcomes = await Promise.allSettled([
      results.seal(projection),
      results.seal({ ...projection, fields: { handle: "other" } }),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const pinned = await results.read(consumption.slotId);
    expect(pinned).not.toBeNull();
    const reopened = await openIntentResults(authorizationId, commitment, root);
    expect(await reopened.read(consumption.slotId)).toEqual(pinned);
    await expect(reopened.seal(pinned!.projection)).resolves.toEqual(pinned);
    await expect(
      reopened.seal({ ...projection, consumption: { ...consumption, argumentSha256: "f".repeat(64) } }),
    ).rejects.toThrow();
    await expect(
      reopened.seal({ ...projection, fields: { handle: "captured", access_token: "never-retain" } }),
    ).rejects.toThrow();
    expect((await store.consume(consumption)).status).toBe("already-consumed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("recovers a result after its publisher exits without granting a second consumption", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const root = await mkdtemp(join(await realpath(tmpdir()), "qualification-result-crash-"));
  try {
    const script = `import { createIntentStore } from ${JSON.stringify(new URL("../intent-store.ts", import.meta.url).href)};
      import { openIntentResults } from ${JSON.stringify(new URL("../intent-results.ts", import.meta.url).href)};
      const args = ${JSON.stringify([authorizationId, commitment, root])};
      const store = await createIntentStore(...args);
      await store.consume(${JSON.stringify(consumption)});
      const results = await openIntentResults(...args);
      await results.seal(${JSON.stringify(projection)});
      process.exit(17);`;
    await expect(
      promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 10000, maxBuffer: 4096 }),
    ).rejects.toMatchObject({ code: 17 });
    const results = await openIntentResults(authorizationId, commitment, root);
    expect((await results.read(consumption.slotId))?.projection).toEqual(projection);
    const store = await createIntentStore(authorizationId, commitment, root);
    expect((await store.consume(consumption)).status).toBe("already-consumed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
