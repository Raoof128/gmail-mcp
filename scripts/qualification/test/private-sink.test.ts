import { expect, it } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateSink, readPrivateJson } from "../private-files.ts";
it("resolves only bounded same-directory artifacts with matching hashes", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "qualification-v2-"));
  try {
    const sink = await createPrivateSink(directory);
    const ref = await sink.write("source.json", { version: 2 });
    await expect(sink.read(ref)).resolves.toEqual({ version: 2 });
    await expect(sink.read({ ...ref, sha256: "0".repeat(64) })).rejects.toThrow();
    await expect(sink.read({ ...ref, name: "../source.json" })).rejects.toThrow();
    await writeFile(join(directory, "invalid.json"), new Uint8Array([255]), { mode: 0o600 });
    await expect(readPrivateJson(join(directory, "invalid.json"))).rejects.toThrow();
    await writeFile(join(directory, "oversized.json"), " ".repeat(65537), { mode: 0o600 });
    await expect(readPrivateJson(join(directory, "oversized.json"))).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
