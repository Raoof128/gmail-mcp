import { expect, it, vi } from "vitest";
import { quarantineRestore } from "../restore.ts";
it("refuses Time Travel without verified writer quiescence", async () => {
  const restore = vi.fn();
  const port = {
    maintenance: () => Promise.resolve().then(() => undefined),
    verifyFrozen: () => Promise.resolve().then(() => undefined),
    drained: () => Promise.resolve().then(() => false),
    exportJournal: vi.fn(),
    write: vi.fn(),
    restore,
    installFrozen: vi.fn(),
  };
  await expect(
    quarantineRestore(
      {
        databaseId: "11111111-1111-4111-8111-111111111111",
        bookmark: "bookmark",
        authorizationExpiresAt: Date.now() + 60000,
        compatibilityVersion: 3,
      },
      port,
    ),
  ).rejects.toThrow();
  expect(restore).not.toHaveBeenCalled();
  expect(port.exportJournal).not.toHaveBeenCalled();
});
it("retains quarantine after restoring a snapshot that lost sent operations", async () => {
  const events: string[] = [];
  const result = await quarantineRestore(
    {
      databaseId: "11111111-1111-4111-8111-111111111111",
      bookmark: "bookmark",
      authorizationExpiresAt: Date.now() + 60000,
      compatibilityVersion: 3,
    },
    {
      maintenance: () =>
        Promise.resolve().then(() => {
          events.push("maintenance");
        }),
      verifyFrozen: () =>
        Promise.resolve().then(() => {
          events.push("frozen");
        }),
      drained: () => Promise.resolve().then(() => true),
      exportJournal: () => Promise.resolve().then(() => ({ sha256: "a".repeat(64), operations: 1, keys: 1 })),
      write: () =>
        Promise.resolve().then(() => {
          events.push("receipt");
        }),
      restore: () =>
        Promise.resolve().then(() => {
          events.push("restore");
        }),
      installFrozen: () =>
        Promise.resolve().then(() => {
          events.push("install_frozen");
        }),
    },
  );
  expect(result.state).toBe("quarantined");
  expect(events.indexOf("receipt")).toBeLessThan(events.indexOf("restore"));
  expect(events.slice(-2)).toEqual(["frozen", "receipt"]);
});
