import { expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateSink } from "../private-files.ts";
import { importDeviceObservation } from "../controllers/device-observations.ts";
import { fixture } from "./v2-fixtures.ts";
it("imports a per-trial operator source and refuses aggregates, foreign identity and fabricated provenance", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "qualification-device-"));
  try {
    const f = fixture(),
      sink = await createPrivateSink(directory);
    for (const [name, artifact] of f.files) await sink.write(name, artifact.value);
    const path = join(directory, f.report.observationRefs[0]!.name);
    const row = await importDeviceObservation(path, f.identity);
    expect(row.details.caseId).toBe("physical-durability");
    expect(row.surface).toBe("device");
    await expect(
      importDeviceObservation(path, { ...f.identity, runId: "11111111-1111-4111-8111-111111111111" }),
    ).rejects.toThrow();
    await sink.write("aggregate.json", { samples: 3, physicalLoss: true });
    await expect(importDeviceObservation(join(directory, "aggregate.json"), f.identity)).rejects.toThrow();
    await sink.write("forged.json", { ...row, sourceSha256: "f".repeat(64) });
    await expect(importDeviceObservation(join(directory, "forged.json"), f.identity)).rejects.toThrow();
    await sink.write("synthetic.json", { ...row, surface: "synthetic" });
    await expect(importDeviceObservation(join(directory, "synthetic.json"), f.identity)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
