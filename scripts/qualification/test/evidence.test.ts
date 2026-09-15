import { expect, it } from "vitest";
import { EvidenceVerifier } from "../contracts-validation.ts";
import { fixture } from "./v2-fixtures.ts";

it("resolves complete component source graph with mixed acknowledged/uncertain trials", async () => {
  const f = fixture();
  await expect(new EvidenceVerifier().validateCase(f.report, f.sink, f.identity)).resolves.toEqual(f.report);
});
it("rejects swapped, missing or extra observations and foreign identities", async () => {
  const f = fixture();
  const verifier = new EvidenceVerifier();
  for (const refs of [
    f.report.observationRefs.slice(1),
    [...f.report.observationRefs, f.report.observationRefs[0]!],
    [f.report.observationRefs[1]!, f.report.observationRefs[0]!, f.report.observationRefs[2]!],
  ])
    await expect(verifier.validateCase({ ...f.report, observationRefs: refs }, f.sink, f.identity)).rejects.toThrow();
  for (const field of ["workerBuildId", "accountId", "credentialVersion"] as const) {
    const target = { ...f.identity.target, [field]: field === "credentialVersion" ? 9 : "foreign" };
    await expect(verifier.validateCase(f.report, f.sink, { ...f.identity, target })).rejects.toThrow();
  }
});
it("rejects omitted preparation failure and forged source bytes", async () => {
  const f = fixture();
  const altered = { ...f.closure, outcomes: f.closure.outcomes.slice(1) };
  await expect(
    new EvidenceVerifier().validateCase(
      { ...f.report, preparationClosure: f.put("altered.json", altered) },
      f.sink,
      f.identity,
    ),
  ).rejects.toThrow();
  f.files.delete(f.report.observationRefs[0]!.name);
  await expect(new EvidenceVerifier().validateCase(f.report, f.sink, f.identity)).rejects.toThrow();
});
