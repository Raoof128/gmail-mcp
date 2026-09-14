import { expect, it, vi } from "vitest";
import { changeQualification, type AdminPort } from "../admin.ts";
import { fixtureManifest } from "./fixtures.ts";
const verified = {
  verify: vi.fn(() => Promise.resolve().then(() => undefined)),
  batch: vi.fn(() => Promise.resolve().then(() => undefined)),
} satisfies AdminPort;
it("refuses normal-profile probes before any platform call", async () => {
  await expect(changeQualification("probe", fixtureManifest(), "a".repeat(64), verified)).rejects.toThrow();
  expect(verified.verify).not.toHaveBeenCalled();
});
it("generates fresh epochs and binds every manifest value", async () => {
  const m = fixtureManifest();
  const a = await changeQualification("disable", m, "a".repeat(64), verified);
  const b = await changeQualification("disable", m, "a".repeat(64), verified);
  expect(a.epoch).toMatch(/^qe_[A-Za-z0-9_-]{43}$/);
  expect(a.epoch).not.toBe(b.epoch);
  expect(verified.batch.mock.calls[0]).toBeDefined();
});
it("refuses enable without sealed live evidence", async () => {
  const port = { verify: vi.fn(), batch: vi.fn() };
  await expect(changeQualification("enable", fixtureManifest(), "a".repeat(64), port)).rejects.toThrow();
  expect(port.verify).not.toHaveBeenCalled();
});
it("executes guarded SQL atomically and rejects a stale epoch", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE _assert(x INTEGER CHECK(x=0)); CREATE TABLE recovery_installation(singleton,schema_version,mutation_state,restore_generation); INSERT INTO recovery_installation VALUES(1,5,'active','generation'); CREATE TABLE accounts(user_id,id,status,credential_version); INSERT INTO accounts VALUES('owner','account','active',1); CREATE TABLE recovery_control(origin,build_id,user_id,account_id,credential_version,mode,state,epoch,expires_at,evidence_hash,probe_ids,PRIMARY KEY(origin,build_id,user_id,account_id,credential_version,mode)); CREATE TABLE operation_recovery(session_enc,session_key_id,lease_token,lease_until,state,user_id,account_id,credential_version,binding_json);",
  );
  const port: AdminPort = {
    verify: () => Promise.resolve().then(() => undefined),
    batch: (stmts) =>
      Promise.resolve().then(() => {
        db.exec("BEGIN");
        try {
          for (const s of stmts) db.prepare(s.sql).run(...s.params);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }),
  };
  try {
    const m = fixtureManifest();
    const first = await changeQualification("disable", m, "a".repeat(64), port);
    await expect(changeQualification("disable", m, "a".repeat(64), port)).rejects.toThrow();
    const next = await changeQualification("disable", { ...m, expectedEpoch: first.epoch }, "a".repeat(64), port);
    expect(next.epoch).not.toBe(first.epoch);
    expect(db.prepare("SELECT epoch FROM recovery_control").get()?.epoch).toBe(next.epoch);
  } finally {
    db.close();
  }
});
it("refuses excessive probe scope before platform verification", async () => {
  const port = { verify: vi.fn(), batch: vi.fn() };
  await expect(
    changeQualification(
      "probe",
      { ...fixtureManifest(), profile: "scratch", probeIds: Array.from({ length: 21 }, (_, i) => `op-${i}`) },
      "a".repeat(64),
      port,
    ),
  ).rejects.toThrow();
  expect(port.verify).not.toHaveBeenCalled();
});
it("disables its fresh epoch if deployment drifts immediately after activation", async () => {
  let checks = 0;
  const batch = vi.fn(() => Promise.resolve());
  const m = { ...fixtureManifest(), expectedEpoch: "qe_" + "A".repeat(43) };
  const port = { verify: () => (++checks === 2 ? Promise.reject(new Error("drift")) : Promise.resolve()), batch };
  const evidence = {
    mode: "live" as const,
    runId: "11111111-1111-4111-8111-111111111111",
    runSha256: "b".repeat(64),
    manifestSha256: "a".repeat(64),
    qualificationEpoch: m.expectedEpoch,
    verify: () => Promise.resolve(),
  };
  await expect(changeQualification("enable", m, "a".repeat(64), port, evidence)).rejects.toThrow();
  expect(batch).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(batch.mock.calls[1])).toContain("disabled");
});
