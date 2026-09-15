import { expect, it, vi } from "vitest";
import { runV2Case, selectRunCase } from "../run-v2.ts";
import { SourceCaseAdapter } from "../case-adapter.ts";
import { Authorization, Observation, PreparationIdentity, type VerifiedControllerContext } from "../contracts.ts";
import { fixture } from "./v2-fixtures.ts";
function setup() {
  const f = fixture();
  const unsupported = () => Promise.reject(new Error("unexpected mutation"));
  const context: VerifiedControllerContext = {
    identity: f.identity,
    preparation: PreparationIdentity.parse(f.closure.identity),
    preparationCommitment: f.identity.preparationCommitment,
    authorization: Authorization.parse(f.files.get("authorization.json")!.value),
    sink: f.sink,
    intents: { consume: unsupported, appendOutcome: unsupported },
    now: () => 500,
    monotonicNow: () => 500,
    verifyTarget: vi.fn(() => Promise.resolve()),
    admitMutation: unsupported,
    workerObserve: unsupported,
    workerMutate: unsupported,
    nativeObserve: unsupported,
    nativeMutate: unsupported,
  };
  const controller = vi.fn(() =>
    Promise.resolve({
      observations: f.report.observationRefs.map((r) => Observation.parse(f.files.get(r.name)!.value)),
      limitation: null,
    }),
  );
  const adapter = new SourceCaseAdapter({ close: () => Promise.resolve(f.report.preparationClosure) });
  return { ...f, context, controller, adapter };
}
it("runs one component and derives its report from the full source graph", async () => {
  const f = setup();
  const write = vi.fn(() => Promise.resolve());
  const result = await runV2Case(f.context, ["physical-durability"], f.controller, f.adapter, { write });
  expect(result.exitCode).toBe(0);
  expect(result.report.result).toBe("pass");
  expect(f.controller).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledTimes(1);
});
it("rejects mixed selection before invoking any controller", () => {
  const f = setup();
  expect(() => selectRunCase(f.identity, ["generated-id", "session-status"])).toThrow();
  expect(() => selectRunCase(f.identity, ["generated-id"])).toThrow();
  for (const mode of ["generated_search", "send_session_status"] as const) {
    const identity = {
      ...f.identity,
      purpose: "recovery-mode" as const,
      mode,
      preparationRoot: "a".repeat(64),
      qualificationEpoch: "qe_" + "A".repeat(43),
      probeExpiresAt: 9000,
    };
    expect(selectRunCase(identity, [mode === "generated_search" ? "generated-id" : "session-status"])).toBe(
      mode === "generated_search" ? "generated-id" : "session-status",
    );
    expect(() => selectRunCase(identity, [mode === "generated_search" ? "session-status" : "generated-id"])).toThrow();
  }
});
it("rejects a caller verdict and does not copy private errors into the result", async () => {
  const f = setup();
  const report = await f.adapter.run(f.context, "physical-durability", () =>
    Promise.reject(new Error("private bearer secret")),
  );
  expect(report.result).toBe("fail");
  expect(JSON.stringify(report)).not.toContain("secret");
  const forged = await f.adapter.run(f.context, "physical-durability", () =>
    Promise.resolve({ observations: [], limitation: null, verdict: "pass" }),
  );
  expect(forged.result).toBe("fail");
});
it("preserves observed rows when target verification drifts after the controller", async () => {
  const f = setup();
  let checks = 0;
  f.context.verifyTarget = () => (++checks === 2 ? Promise.reject(new Error("drift")) : Promise.resolve());
  const report = await f.adapter.run(f.context, "physical-durability", f.controller);
  expect(report.result).toBe("fail");
  expect(report.limitation).toBe("identity_drift");
  expect(report.observationRefs).toHaveLength(3);
});
it("does not let a controller replace its target verifier or mutate frozen identity", async () => {
  const f = setup();
  const report = await f.adapter.run(f.context, "physical-durability", (context) => {
    context.identity.target.credentialVersion = 99;
    return Promise.resolve({ observations: [], limitation: null });
  });
  expect(report.result).toBe("fail");
  expect(f.context.identity.target.credentialVersion).toBe(1);
});
it("does not hide observed safety failures behind an unavailable-controller reason", async () => {
  const f = setup();
  const result = await f.controller();
  const report = await f.adapter.run(f.context, "physical-durability", () =>
    Promise.resolve({
      observations: result.observations.map((o) => ({ ...o, safety: { ...o.safety, duplicates: 1 } })),
      limitation: "missing_adapter",
    }),
  );
  expect(report.result).toBe("fail");
});
