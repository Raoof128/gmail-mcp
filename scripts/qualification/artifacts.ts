import { z } from "zod";
import { caseIds, hash } from "./manifest.ts";
const common = {
  version: z.literal(1),
  run_id: z.string().uuid(),
  case_id: z.enum(caseIds),
  manifest_sha256: hash,
  worker_build: hash,
};
const metricNames = [
  "samples",
  "exact_matches",
  "replays",
  "final_receipts",
  "executed_audits",
  "synthetic_samples",
  "live_observations",
  "automatic_confirmations",
  "verified_digests",
  "max_attachment_bytes",
  "max_encoded_bytes",
  "expected_transports",
  "external_mutations",
  "correct_threads",
  "revocations",
  "refused_after_revoke",
  "client_flows",
  "login_cycles",
  "kill_points",
  "power_trials",
  "ack_survived",
  "uncertain_ack",
  "serial_round_trips",
  "concurrent_downloads",
  "peak_memory_bytes",
  "cpu_max_ms",
  "route_cpu_limit_ms",
  "permitless_refusals",
  "stale_epochs_refused",
  "maintenance_cases",
  "direct_winners",
  "duplicates",
  "false_confirmations",
  "unexpected_recipients",
  "credential_leaks",
  "overwrites",
  "resource_errors",
] as const;
export const artifactSchema = z.discriminatedUnion("mode", [
  z
    .object({
      ...common,
      mode: z.literal("synthetic"),
      tests: z.array(z.string().regex(/^[a-z0-9-]+\.test\.ts$/)).min(1),
      passed: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...common,
      mode: z.literal("live"),
      metrics: z.partialRecord(z.enum(metricNames), z.number().finite().nonnegative()),
    })
    .strict(),
]);
export function validateLiveArtifact(input: unknown) {
  const a = artifactSchema.parse(input);
  if (a.mode !== "live") throw new Error("synthetic artifact cannot qualify live recovery");
  const m = a.metrics;
  const required: Record<(typeof caseIds)[number], Partial<typeof m>> = {
    "generated-id": { samples: 3, exact_matches: 3, replays: 3 },
    "session-status": { samples: 3, final_receipts: 3, executed_audits: 3 },
    "draft-negative": { synthetic_samples: 3, live_observations: 1, automatic_confirmations: 0 },
    "byte-round-trip": { samples: 6, verified_digests: 6, max_attachment_bytes: 26214400 },
    "media-boundary": { samples: 6, expected_transports: 6, external_mutations: 6 },
    "reply-revoke": { samples: 3, correct_threads: 3, revocations: 1, refused_after_revoke: 1 },
    "installed-clients": { client_flows: 9 },
    native: { login_cycles: 3, kill_points: 10 },
    "physical-durability": { power_trials: 3, ack_survived: 3, uncertain_ack: 0 },
    resources: { serial_round_trips: 10, concurrent_downloads: 2 },
    rollback: { permitless_refusals: 1, stale_epochs_refused: 1, maintenance_cases: 3, direct_winners: 1 },
  };
  for (const k of [
    "duplicates",
    "false_confirmations",
    "unexpected_recipients",
    "credential_leaks",
    "overwrites",
    "resource_errors",
  ] as const)
    if (m[k] !== 0) throw new Error("safety evidence missing or failed");
  for (const [k, value] of Object.entries(required[a.case_id]))
    if (m[k as (typeof metricNames)[number]] !== value) throw new Error("mandatory sample evidence missing");
  if (a.case_id === "byte-round-trip" && (m.max_encoded_bytes === undefined || m.max_encoded_bytes > 36700160))
    throw new Error("encoded byte evidence refused");
  if (
    a.case_id === "resources" &&
    (m.peak_memory_bytes === undefined ||
      m.peak_memory_bytes >= 128000000 ||
      m.cpu_max_ms === undefined ||
      !m.route_cpu_limit_ms ||
      m.cpu_max_ms >= m.route_cpu_limit_ms)
  )
    throw new Error("resource measurement missing or exceeded");
  return a;
}
