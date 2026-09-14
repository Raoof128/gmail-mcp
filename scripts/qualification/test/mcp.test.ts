import { expect, it, vi } from "vitest";
import { QualificationMcp } from "../cases/mcp.ts";
import { fixtureManifest } from "./fixtures.ts";
it("refuses fixture send before credentials when authorization is missing", async () => {
  const token = vi.fn(() => "token");
  const transport = vi.fn();
  const client = new QualificationMcp(fixtureManifest(), token, transport);
  await expect(client.sendFixture("run", 0)).rejects.toThrow();
  expect(token).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});
it("stops on serving identity drift even on a credentialed error response", async () => {
  const m = { ...fixtureManifest(), accountAlias: "work" };
  const client = new QualificationMcp(
    m,
    () => "token",
    () =>
      Promise.resolve(
        new Response("private provider error", {
          status: 500,
          headers: { "x-recovery-build": m.workerBuildId, "x-recovery-version": "other" },
        }),
      ),
  );
  await expect(client.read("get_message", { message_id: "m1" })).rejects.toThrow("identity");
});
