import { fixtureCase, type CaseContext } from "./types.ts";
export const resourceCases = (c: CaseContext) => [
  fixtureCase("resources", [], c),
  fixtureCase(
    "rollback",
    [
      "recovery-state.test.ts",
      "recovery-faults.test.ts",
      "restore-floor.test.ts",
      "recovery-cron.test.ts",
      "recovery-retention.test.ts",
    ],
    c,
  ),
];
