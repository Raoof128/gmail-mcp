import { expect, it } from "vitest";
import { ModeEvidence, requiredProof, Observation, ManifestV2 } from "../contracts.ts";
import { deriveCaseVerdict } from "../contracts-validation.ts";
const hash = "a".repeat(64);
const observation = (trial: number, acknowledgedBeforeLoss: boolean) => ({
  version: 2,
  sampleId: `00000000-0000-4000-8000-${String(trial).padStart(12, "0")}`,
  identitySha256: hash,
  sourceSha256: hash,
  surface: "device",
  recordedAt: 100,
  safety: {
    duplicates: 0,
    falseConfirmations: 0,
    unexpectedRecipients: 0,
    credentialLeaks: 0,
    overwrites: 0,
    resourceErrors: 0,
  },
  details: {
    caseId: "physical-durability",
    trial,
    deviceSha256: hash,
    physicalLoss: true,
    acknowledgedBeforeLoss,
    recoveredDigestMatches: acknowledgedBeforeLoss,
    uncertainAcknowledged: false,
  },
});
it("rejects legacy evidence, aggregates and unsupported manifest states", () => {
  expect(ModeEvidence.safeParse({ version: 1, purpose: "recovery-mode" }).success).toBe(false);
  expect(Observation.safeParse({ samples: 3, ack_survived: 3 }).success).toBe(false);
  expect(ManifestV2.safeParse({ version: 2, purpose: "release-component", phase: "disable" }).success).toBe(false);
  expect(requiredProof("generated_search")).toBe("generated-id");
  expect(requiredProof("send_session_status")).toBe("session-status");
});
it("accepts acknowledged and uncertain physical trials without inventing acknowledgements", () => {
  const rows = [observation(1, true), observation(2, false), observation(3, true)].map((o) => Observation.parse(o));
  expect(deriveCaseVerdict("physical-durability", rows)).toBe("pass");
  expect(deriveCaseVerdict("physical-durability", rows.slice(1))).toBe("fail");
  expect(deriveCaseVerdict("physical-durability", [rows[0]!, rows[0]!, rows[2]!])).toBe("fail");
  expect(
    deriveCaseVerdict(
      "physical-durability",
      rows.map((o) => ({ ...o, surface: "synthetic" })),
    ),
  ).toBe("fail");
});
it("refuses a safety counter or uncertainty falsely acknowledged", () => {
  const rows = [1, 2, 3].map((n) => Observation.parse(observation(n, n !== 2)));
  expect(
    deriveCaseVerdict(
      "physical-durability",
      rows.map((o) => ({ ...o, safety: { ...o.safety, duplicates: 1 } })),
    ),
  ).toBe("fail");
  const wrong = Observation.parse(observation(2, false));
  if (wrong.details.caseId === "physical-durability") wrong.details.uncertainAcknowledged = true;
  expect(deriveCaseVerdict("physical-durability", [rows[0]!, wrong, rows[2]!])).toBe("fail");
});
