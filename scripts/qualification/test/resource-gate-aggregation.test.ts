import { expect, it } from "vitest";
import { assessRelease } from "../assess-release.ts";
import { CommonCases } from "../contracts.ts";
import { fixture } from "./v2-fixtures.ts";

/**
 * The peak isolate memory gate has no refusal path of its own (finding G-006), so the thing that has to
 * hold is one step further out: the absence of resource evidence must not be able to disappear from the
 * release aggregate. If it could, an unmeasured gate would silently stop blocking anything.
 */
it("keeps resources in the set of components a release aggregate requires", () => {
  // A future edit that drops it from this list would make the case below pass for the wrong reason.
  expect([...CommonCases]).toContain("resources");
});

it("cannot reach a passing qualification while resource evidence is absent", async () => {
  const f = fixture();
  // Everything the aggregate asks for except the one case that would carry a memory measurement.
  const components = CommonCases.filter((caseId) => caseId !== "resources").map((caseId) => ({
    caseId,
    report: f.put(`report-${caseId}.json`, { ...f.report, caseId }),
  }));
  const result = await assessRelease({ version: 2, target: f.identity.target, modes: [], components }, f.sink);

  // Exactly one component is missing, and it is the resource one: everything else really was supplied,
  // so this is not a partial aggregate failing for some other reason.
  const missing = result.blockers.filter((b) => b.startsWith("missing_component:"));
  expect(missing).toEqual(["missing_component:resources"]);
  expect(result.qualification).not.toBe("pass");
  expect(result.release).not.toBe("pass");
  expect(result.verifiedComponents).toBeLessThan(CommonCases.length);
});

it("cannot reach a passing qualification from components alone, with no mode evidence at all", async () => {
  const f = fixture();
  const components = CommonCases.map((caseId) => ({
    caseId,
    report: f.put(`full-${caseId}.json`, { ...f.report, caseId }),
  }));
  const result = await assessRelease({ version: 2, target: f.identity.target, modes: [], components }, f.sink);
  expect(result.blockers.filter((b) => b.startsWith("missing_component:"))).toEqual([]);
  expect(result.qualification).not.toBe("pass");
  expect(result.blockers).toContain("missing_mode:generated_search");
  expect(result.blockers).toContain("missing_mode:send_session_status");
});

it("never reports a passing release, and always carries the implementation blocker", async () => {
  const f = fixture();
  for (const input of [{ version: 2, target: f.identity.target, modes: [], components: [] }, { not: "a manifest" }]) {
    const result = await assessRelease(input, f.sink);
    expect(result.release).not.toBe("pass");
    expect(result.implementation).toBe("not_run");
    expect(result.blockers).toContain("implementation_incomplete");
  }
});
