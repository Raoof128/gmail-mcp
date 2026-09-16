import { legacyWriterCorpus } from "./fixtures/legacy-writer-corpus";
type Site = (typeof legacyWriterCorpus)[number];
const group = (...files: string[]) =>
  Object.freeze(legacyWriterCorpus.filter((s) => files.some((f) => s.file === `worker/src/${f}.ts`)));
export const legacyGroups = Object.freeze({
  settlement: group("tools/settle", "audit/log"),
  journal: group("operations/journal"),
  cron: group("cron"),
  approval: group("approval/claim", "approval/pending", "tools/idempotency"),
  auth: group("auth/companion", "web/login", "web/session", "web/state"),
  accounts: group("google/connect", "google/tokens", "policy/engine", "web/pages/accounts"),
  staging: group("staging/store", "staging/downloads", "staging/materialization", "staging/budgets"),
  uploads: group("staging/transfers", "staging/upload", "staging/recovery"),
});
const key = (site: Site) => `${site.file}:${site.line}:${site.sha256}`;
/** Tests record only after executing a matched statement and checking its resulting state. */
export class LegacyCoverage {
  private readonly expected: Set<string>;
  private readonly completed = new Set<string>();
  constructor(group: keyof typeof legacyGroups) {
    this.expected = new Set(legacyGroups[group].map(key));
  }
  record(site: Site): void {
    if (!this.expected.has(key(site))) throw new Error("unexpected legacy execution");
    this.completed.add(key(site));
  }
  verify(): void {
    if (this.completed.size !== this.expected.size || [...this.expected].some((k) => !this.completed.has(k)))
      throw new Error("missing legacy execution");
  }
}
