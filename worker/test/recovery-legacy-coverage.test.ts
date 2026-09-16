import { expect, it } from "vitest";
import { legacyWriterCorpus } from "./fixtures/legacy-writer-corpus";
import { LegacyCoverage, legacyGroups } from "./legacy-coverage";
it("requires exactly all 136 site identities across the executable groups", () => {
  const sites = Object.values(legacyGroups).flat();
  expect(sites).toHaveLength(136);
  expect(new Set(sites.map((s) => `${s.file}:${s.line}:${s.sha256}`)).size).toBe(136);
  expect(sites.map((s) => `${s.file}:${s.line}:${s.sha256}`).sort()).toEqual(
    legacyWriterCorpus.map((s) => `${s.file}:${s.line}:${s.sha256}`).sort(),
  );
});
it("refuses a missing duplicate-body site and an unregistered execution", () => {
  const coverage = new LegacyCoverage("journal");
  for (const site of legacyGroups.journal.filter((s) => s.line !== "99")) coverage.record(site);
  expect(() => coverage.verify()).toThrow("missing legacy execution");
  expect(() => coverage.record(legacyGroups.auth[0]!)).toThrow("unexpected legacy execution");
  coverage.record(legacyGroups.journal.find((s) => s.line === "99")!);
  expect(() => coverage.verify()).not.toThrow();
});
