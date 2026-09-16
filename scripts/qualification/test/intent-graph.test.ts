import { join } from "node:path";
import { expect, it } from "vitest";
import { canonicalize } from "../../../worker/src/crypto/canonical.ts";
import { Authorization, PreparationIdentity, IntentTemplate, identityHash } from "../contracts.ts";
import { digest } from "../private-files.ts";
import { validateIntentGraph } from "../intent-graph.ts";
import { fixture } from "./v2-fixtures.ts";
function graph() {
  const f = fixture();
  const auth = Authorization.parse({
    ...(f.files.get("authorization.json")!.value as object),
    capabilities: ["staging", "send"],
    maxMutations: 2,
    maxWriteBytes: 20,
  });
  const sampleId = f.closure.identity.allocations[0]!.sampleId;
  const slots = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const preparation = PreparationIdentity.parse({
    ...f.closure.identity,
    authorizationSha256: identityHash("authorization", auth, canonicalize),
    allocations: [
      {
        sampleId,
        caseId: "byte-round-trip",
        slots: slots.map((slotId, i) => ({ slotId, capability: i ? "send" : "staging", maxBodyBytes: 10 })),
      },
    ],
  });
  const templates = slots.map((slotId, i) =>
    IntentTemplate.parse({
      version: 2,
      allocationHash: identityHash("preparation", preparation, canonicalize),
      sampleId,
      slotId,
      capability: i ? "send" : "staging",
      tool: i ? "send_message" : "staging_upload",
      targetScope: "primary",
      literals: {},
      references: i
        ? [{ targetPath: ["attachments", 0], sourceSampleId: sampleId, sourceSlotId: slots[0], field: "handle" }]
        : [],
      idempotencyKey: `key-${i}`,
      declaredBytes: 10,
    }),
  );
  const refs = () => templates.map((t, i) => ({ name: `intent-${i}.json`, sha256: digest(canonicalize(t)) }));
  return { auth, preparation, templates, refs };
}
it("validates the committed ordered graph and canonical template bytes", () => {
  const g = graph();
  expect(() => validateIntentGraph(g.preparation, g.auth, g.refs(), g.templates)).not.toThrow();
  expect(() =>
    validateIntentGraph(
      g.preparation,
      g.auth,
      g.refs().map((r) => ({ ...r, sha256: "f".repeat(64) })),
      g.templates,
    ),
  ).toThrow();
});
it("rejects forward dependencies, duplicate target paths and literal replacement", () => {
  for (const change of ["forward", "duplicate", "literal", "prototype"] as const) {
    const g = graph();
    if (change === "forward")
      g.templates[0]!.references = [{ ...g.templates[1]!.references[0]!, sourceSlotId: g.templates[1]!.slotId }];
    if (change === "duplicate") g.templates[1]!.references.push(g.templates[1]!.references[0]!);
    if (change === "literal") g.templates[1]!.literals = { attachments: ["already-committed"] };
    if (change === "prototype") g.templates[1]!.references[0]!.targetPath = ["attachments", "__proto__", "x"];
    expect(() => validateIntentGraph(g.preparation, g.auth, g.refs(), g.templates)).toThrow();
  }
});
it("writes template artifacts in the exact canonical encoding required by admission", async () => {
  const { mkdtemp, realpath, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { writeIntentTemplate } = await import("../intent-graph.ts");
  const directory = await mkdtemp(join(await realpath(tmpdir()), "qualification-template-"));
  try {
    const g = graph();
    const ref = await writeIntentTemplate(directory, "intent.json", g.templates[0]);
    const bytes = await readFile(join(directory, ref.name));
    expect(bytes.toString("utf8")).toBe(canonicalize(g.templates[0]));
    expect(ref.sha256).toBe(g.refs()[0]!.sha256);
    await expect(writeIntentTemplate(directory, "intent.json", g.templates[1])).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
