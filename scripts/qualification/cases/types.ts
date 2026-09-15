import type { Manifest } from "../manifest.ts";
import type { CaseOutcome, RunIdentity, TestCase } from "../legacy-run.ts";
export interface CaseContext {
  manifest: Manifest;
  synthetic: boolean;
  local(files: string[], identity: Readonly<RunIdentity>, caseId: TestCase["id"]): Promise<CaseOutcome>;
  /** Live ports are concrete installed-client or private fixture controllers, never synthetic substitutes. */
  live?: Partial<Record<TestCase["id"], (identity: Readonly<RunIdentity>) => Promise<CaseOutcome>>>;
}
export function fixtureCase(
  id: TestCase["id"],
  files: string[],
  context: CaseContext,
  capability?: "send" | "revoke" | "power-loss",
): TestCase {
  return {
    id,
    requiresLive: !context.synthetic,
    run: async (identity) => {
      if (context.synthetic) {
        if (files.length === 0)
          return { result: "not_run", attempts: 0, artifact_sha256: null, limitation: "operator_required" };
        return context.local(files, identity, id);
      }
      const auth = context.manifest.authorization;
      if (capability && (!auth || auth.expiresAt <= Date.now() || !auth.capabilities.includes(capability)))
        return { result: "not_run", attempts: 0, artifact_sha256: null, limitation: "missing_authorization" };
      const adapter = context.live?.[id];
      if (!adapter) return { result: "not_run", attempts: 0, artifact_sha256: null, limitation: "missing_adapter" };
      return adapter(identity);
    },
  };
}
