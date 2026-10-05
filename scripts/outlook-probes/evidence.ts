import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Exchange } from "./graph.ts";
import { redact } from "./redact.ts";

export type Fact = string | number | boolean | null | Fact[] | { [key: string]: Fact };

export type Outcome = "observed" | "skipped" | "refused" | "error";

export interface ProbeRecord {
  id: string;
  title: string;
  kind: string;
  outcome: Outcome;
  reason?: string;
  startedAt: string;
  ms: number;
  facts: Record<string, Fact>;
  exchanges: Exchange[];
}

export interface RunRecord {
  harness: "outlook-probes";
  version: 1;
  runTag: string;
  startedAt: string;
  authorityKind: "consumers" | "tenant";
  gates: Record<string, boolean>;
  /** Graded the same way as the gauntlet: a probe run is live evidence, a synthetic run never is. */
  evidenceKind: "live" | "synthetic";
  probes: ProbeRecord[];
}

/** Every string fact passes through `redact`, so a probe cannot record an address or a token by mistake. */
export function scrub(value: Fact): Fact {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === "object") {
    const out: Record<string, Fact> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v);
    return out;
  }
  return value;
}

export class Recorder {
  private readonly facts: Record<string, Fact> = {};

  set(key: string, value: Fact): void {
    this.facts[key] = scrub(value);
  }

  push(key: string, value: Fact): void {
    const cur = this.facts[key];
    const next = scrub(value);
    this.facts[key] = Array.isArray(cur) ? [...cur, next] : [next];
  }

  snapshot(): Record<string, Fact> {
    return { ...this.facts };
  }
}

/** Writes the run with owner-only permissions. Redacted or not, it describes a private mailbox. */
export function writeRun(dir: string, run: RunRecord): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `outlook-probes-${run.runTag}.json`);
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return file;
}
