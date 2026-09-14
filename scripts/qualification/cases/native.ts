import { fixtureCase, type CaseContext } from "./types.ts";
export const nativeCases = (c: CaseContext) => [
  fixtureCase("native", [], c),
  fixtureCase("physical-durability", [], c, "power-loss"),
];
