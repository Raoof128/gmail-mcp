import { expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Authorization, PreparationIdentity, type VerifiedControllerContext } from "../contracts.ts";
import { createPrivateSink } from "../private-files.ts";
import { createDeviceController } from "../controllers/device-controller.ts";
import { fixture } from "./v2-fixtures.ts";
it("imports allocated per-trial records and stops at the first invalid record retaining prior observations", async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "qualification-device-controller-"));
  try {
    const f = fixture(),
      sink = await createPrivateSink(directory);
    for (const [name, artifact] of f.files) await sink.write(name, artifact.value);
    const unsupported = vi.fn(() => Promise.reject(new Error("unexpected mutation")));
    const verify = vi.fn(() => Promise.resolve());
    const context: VerifiedControllerContext = {
      identity: f.identity,
      preparation: PreparationIdentity.parse(f.closure.identity),
      preparationCommitment: f.identity.preparationCommitment,
      authorization: Authorization.parse(await sink.read(f.closure.authorization)),
      sink,
      intents: { consume: unsupported, appendOutcome: unsupported },
      now: () => 500,
      monotonicNow: () => 500,
      verifyTarget: verify,
      admitMutation: unsupported,
      workerObserve: unsupported,
      workerMutate: unsupported,
      nativeObserve: unsupported,
      nativeMutate: unsupported,
    };
    const paths = f.report.observationRefs.map((r) => join(directory, r.name));
    const complete = await createDeviceController("physical-durability", paths)(context);
    expect(complete.observations).toHaveLength(3);
    expect(complete.limitation).toBeNull();
    const failed = await createDeviceController("physical-durability", [paths[0]!, paths[0]!, paths[2]!])(context);
    expect(failed.observations).toHaveLength(1);
    expect(failed.limitation).toBe("invalid_evidence");
    expect(unsupported).not.toHaveBeenCalled();
    const missing = await createDeviceController("physical-durability", [])(context);
    expect(missing.limitation).toBe("operator_required");
    const unauthorized = await createDeviceController(
      "physical-durability",
      paths,
    )({ ...context, authorization: { ...context.authorization, capabilities: [] } });
    expect(unauthorized.observations).toHaveLength(0);
    expect(unauthorized.limitation).toBe("missing_authorization");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
