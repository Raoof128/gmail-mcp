import { fixtureCase, type CaseContext } from "./types.ts";
export const gmailCases = (c: CaseContext) => [
  fixtureCase("generated-id", ["reconcile.test.ts", "recovery-binding.test.ts"], c, "send"),
  fixtureCase("session-status", ["resumable.test.ts", "recovery-send.test.ts"], c, "send"),
  fixtureCase("draft-negative", ["send-tools.test.ts", "reconcile.test.ts"], c, "send"),
  fixtureCase("byte-round-trip", ["upload-ceiling.test.ts", "staging.test.ts"], c, "send"),
  fixtureCase("media-boundary", ["send-pipeline.test.ts"], c, "send"),
  fixtureCase("reply-revoke", ["send-tools.test.ts", "recovery-tokens.test.ts"], c, "revoke"),
];
