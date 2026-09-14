import { gmailCases } from "./gmail.ts";
import { clientCases } from "./clients.ts";
import { nativeCases } from "./native.ts";
import { resourceCases } from "./resources.ts";
import type { CaseContext } from "./types.ts";
export const caseRegistry = (context: CaseContext) => [
  ...gmailCases(context),
  ...clientCases(context),
  ...nativeCases(context),
  ...resourceCases(context),
];
