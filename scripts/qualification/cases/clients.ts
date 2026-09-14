import { fixtureCase, type CaseContext } from "./types.ts";
export const clientCases = (c: CaseContext) => [
  fixtureCase("installed-clients", ["mcp.test.ts", "elicitation.test.ts", "companion-roundtrip.test.ts"], c, "send"),
];
