import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { EvidenceVerifier } from "../contracts-validation.ts";
import { Observation, type RunIdentity } from "../contracts.ts";
import { fixture } from "./v2-fixtures.ts";

/**
 * Identity substitution against the evidence graph. Each case changes the run identity in the report and
 * in the expectation together, so the top-level equality check passes and only a deeper binding can
 * refuse. Changing one side alone would prove nothing beyond that `assertEqual` exists.
 */
type Axis = { name: string; apply: (identity: RunIdentity) => RunIdentity };
const AXES: Axis[] = [
  { name: "owner", apply: (i) => ({ ...i, target: { ...i.target, userId: "intruder" } }) },
  { name: "account", apply: (i) => ({ ...i, target: { ...i.target, accountId: "other-account" } }) },
  {
    name: "grant epoch",
    apply: (i) => ({ ...i, target: { ...i.target, credentialVersion: i.target.credentialVersion + 1 } }),
  },
  {
    name: "deployment",
    apply: (i) => ({ ...i, target: { ...i.target, deploymentId: "00000000-0000-4000-8000-0000000000aa" } }),
  },
  {
    name: "deployed version",
    apply: (i) => ({ ...i, target: { ...i.target, deploymentVersionId: "00000000-0000-4000-8000-0000000000ab" } }),
  },
  { name: "build", apply: (i) => ({ ...i, target: { ...i.target, workerBuildId: "b".repeat(64) } }) },
  { name: "origin", apply: (i) => ({ ...i, target: { ...i.target, origin: "https://other.example" } }) },
  { name: "profile", apply: (i) => ({ ...i, target: { ...i.target, profile: "scratch" as const } }) },
  { name: "schema", apply: (i) => ({ ...i, target: { ...i.target, schemaSha256: "c".repeat(64) } }) },
  { name: "run id", apply: (i) => ({ ...i, runId: "00000000-0000-4000-8000-0000000000ac" }) },
  { name: "manifest", apply: (i) => ({ ...i, manifestSha256: "d".repeat(64) }) },
  { name: "start time", apply: (i) => ({ ...i, startedAt: i.startedAt + 1 }) },
];

describe("evidence cannot be re-pointed at another identity", () => {
  it("accepts the graph it was actually produced for", async () => {
    const f = fixture();
    await expect(new EvidenceVerifier().validateCase(f.report, f.sink, f.identity)).resolves.toEqual(f.report);
  });

  it.each(AXES.map((a) => [a.name, a] as const))(
    "refuses evidence re-pointed at a different %s",
    async (_name, axis) => {
      const f = fixture();
      const identity = axis.apply(f.identity);
      // Both sides moved together, so this is the graph refusing rather than the equality check.
      await expect(new EvidenceVerifier().validateCase({ ...f.report, identity }, f.sink, identity)).rejects.toThrow();
    },
  );

  it("refuses a report whose identity disagrees with the expectation", async () => {
    const f = fixture();
    const identity = { ...f.identity, runId: "00000000-0000-4000-8000-0000000000ad" };
    await expect(new EvidenceVerifier().validateCase({ ...f.report, identity }, f.sink, f.identity)).rejects.toThrow();
  });

  it("refuses a component claiming a case its preparation did not allocate", async () => {
    const f = fixture();
    await expect(
      new EvidenceVerifier().validateCase({ ...f.report, caseId: "byte-round-trip" }, f.sink, f.identity),
    ).rejects.toThrow();
  });

  it("refuses a report that did not pass, at the verifier rather than the schema", async () => {
    const f = fixture();
    // A failing report needs a limitation to be schema-valid at all, so a bare result flip never reaches
    // the case_failed check. This supplies one so the guard itself is what refuses.
    await expect(
      new EvidenceVerifier().validateCase(
        { ...f.report, result: "fail", limitation: "case_failed" },
        f.sink,
        f.identity,
      ),
    ).rejects.toThrow("case_failed");
  });
});

describe("evidence graph corruption", () => {
  it("refuses a source reference whose digest does not match the stored bytes", async () => {
    const f = fixture();
    const ref = { ...f.report.preparationClosure, sha256: "e".repeat(64) };
    await expect(
      new EvidenceVerifier().validateCase({ ...f.report, preparationClosure: ref }, f.sink, f.identity),
    ).rejects.toThrow();
  });

  it("refuses an observation whose bytes changed after it was referenced", async () => {
    const f = fixture();
    const ref = f.report.observationRefs[0]!;
    const original = Observation.parse(f.files.get(ref.name)!.value);
    // Same reference, different content: the sink checks the digest it was handed.
    f.files.set(ref.name, { sha256: ref.sha256, value: { ...original, recordedAt: original.recordedAt + 1 } });
    await expect(new EvidenceVerifier().validateCase(f.report, f.sink, f.identity)).rejects.toThrow();
  });

  it("refuses a duplicated sample in place of a distinct one", async () => {
    const f = fixture();
    const refs = [f.report.observationRefs[0]!, f.report.observationRefs[0]!, f.report.observationRefs[2]!];
    await expect(
      new EvidenceVerifier().validateCase({ ...f.report, observationRefs: refs }, f.sink, f.identity),
    ).rejects.toThrow();
  });

  it("refuses an authorization swapped for another one", async () => {
    const f = fixture();
    const auth = f.files.get("authorization.json")!.value as Record<string, unknown>;
    const foreign = { ...auth, authorizationId: "00000000-0000-4000-8000-0000000000ae", capabilities: ["send"] };
    const closure = { ...f.closure, authorization: f.put("foreign-auth.json", foreign) };
    await expect(
      new EvidenceVerifier().validateCase(
        { ...f.report, preparationClosure: f.put("closure-foreign.json", closure) },
        f.sink,
        f.identity,
      ),
    ).rejects.toThrow();
  });

  it("refuses a preparation root that does not hash the preparation it ships with", async () => {
    const f = fixture();
    await expect(
      new EvidenceVerifier().validateCase({ ...f.report, preparationRoot: "f".repeat(64) }, f.sink, f.identity),
    ).rejects.toThrow("preparation_incomplete");
  });

  it("refuses an attempt count that disagrees with the allocations", async () => {
    const f = fixture();
    await expect(new EvidenceVerifier().validateCase({ ...f.report, attempts: 2 }, f.sink, f.identity)).rejects.toThrow(
      "preparation_incomplete",
    );
  });

  it("refuses a version-1 shaped artifact supplied to the v2 verifier", async () => {
    const f = fixture();
    const { version: _drop, ...rest } = f.report;
    await expect(new EvidenceVerifier().validateCase({ ...rest, version: 1 }, f.sink, f.identity)).rejects.toThrow();
  });

  it("refuses a source whose recorded digest was recomputed over different bytes", async () => {
    const f = fixture();
    const ref = f.closure.sourceRefs[0]!;
    const ready = f.files.get(ref.name)!.value as Record<string, unknown>;
    const forged = { ...ready, observationSourceSha256: createHash("sha256").update("forged").digest("hex") };
    const closure = {
      ...f.closure,
      sourceRefs: [f.put("forged-ready.json", forged), ...f.closure.sourceRefs.slice(1)],
    };
    await expect(
      new EvidenceVerifier().validateCase(
        { ...f.report, preparationClosure: f.put("closure-forged.json", closure) },
        f.sink,
        f.identity,
      ),
    ).rejects.toThrow();
  });
});
