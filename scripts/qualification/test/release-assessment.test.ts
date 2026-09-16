import { expect, it } from "vitest";
import { assessRelease } from "../assess-release.ts";
import { fixture } from "./v2-fixtures.ts";
it("reports missing surfaces and never promotes partial component evidence into release authority", async () => {
  const f = fixture();
  const input = {
    version: 2,
    target: f.identity.target,
    modes: [],
    components: [{ caseId: "physical-durability", report: f.put("report.json", f.report) }],
  };
  const result = await assessRelease(input, f.sink);
  expect(result.qualification).toBe("not_run");
  expect(result.release).toBe("not_run");
  expect(result.verifiedComponents).toBe(1);
  expect(result.blockers).toContain("missing_mode:generated_search");
  expect(result.blockers).toContain("missing_component:native");
  expect(result.blockers).toContain("implementation_incomplete");
  expect(JSON.stringify(result)).not.toContain("account");
});
it("rejects aggregates and altered source graphs with a finite public failure", async () => {
  const f = fixture();
  expect((await assessRelease({ samples: 3, passed: true }, f.sink)).qualification).toBe("fail");
  const report = { ...f.report, attempts: 99 };
  const result = await assessRelease(
    {
      version: 2,
      target: f.identity.target,
      modes: [],
      components: [{ caseId: "physical-durability", report: f.put("forged-report.json", report) }],
    },
    f.sink,
  );
  expect(result.qualification).toBe("fail");
  expect(result.verifiedComponents).toBe(0);
  expect(result.blockers).toContain("invalid_component:physical-durability");
});
it("rejects component evidence from another target even when its source graph is valid", async () => {
  const f = fixture();
  const result = await assessRelease(
    {
      version: 2,
      target: { ...f.identity.target, credentialVersion: 2 },
      modes: [],
      components: [{ caseId: "physical-durability", report: f.put("report.json", f.report) }],
    },
    f.sink,
  );
  expect(result.qualification).toBe("fail");
  expect(result.verifiedComponents).toBe(0);
});
