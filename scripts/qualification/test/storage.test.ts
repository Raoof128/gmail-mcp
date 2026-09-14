import { expect, it, vi } from "vitest";
import { abandonStorage } from "../storage.ts";
import { fixtureManifest } from "./fixtures.ts";
it("refuses unknown producers before DELETE can race a late PUT", async () => {
  const remove = vi.fn();
  const m = {
    ...fixtureManifest(),
    operationId: "operation",
    storageIntent: { handles: ["handle"], reference: "intent", expiresAt: Date.now() + 60000 },
  };
  const port = {
    verify: () => Promise.resolve().then(() => undefined),
    batch: vi.fn(),
    select: () => Promise.resolve().then(() => [{ handle: "handle", r2_key: "object", stopped: 0 }]),
    remove,
  };
  await expect(abandonStorage(m, "a".repeat(64), port)).rejects.toThrow();
  expect(remove).not.toHaveBeenCalled();
  expect(port.batch).not.toHaveBeenCalled();
});
