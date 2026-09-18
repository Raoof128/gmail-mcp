import { expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { abandonStorage } from "../storage.ts";
import type { StoragePort } from "../storage.ts";
import type { Statement } from "../admin.ts";
import { fixtureManifest } from "./fixtures.ts";

const SCHEMA = `
CREATE TABLE _assert(x INTEGER CHECK(x=0));
CREATE TABLE recovery_installation(singleton,schema_version,mutation_state,restore_generation);
INSERT INTO recovery_installation VALUES(1,5,'active','generation');
CREATE TABLE operations(id,user_id,account_id,settlement_protocol,state);
INSERT INTO operations VALUES('operation','owner','account',2,'delivery_unknown');
CREATE TABLE staging_objects(user_id,account_id,settlement_operation_id,handle,r2_key,cleanup_state);
CREATE TABLE staging_ingests(r2_key,writer_stopped,state);
CREATE TABLE upload_generations(r2_key,writer_stopped,cleanup_state);
CREATE TABLE settlement_permits(operation_id,token,purpose);
`;

/** Two stopped, published source objects bound to one delivery_unknown operation. */
function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  for (const n of [1, 2]) {
    db.exec(
      `INSERT INTO staging_objects VALUES('owner','account','operation','handle${n}','object${n}','retained');
       INSERT INTO staging_ingests VALUES('object${n}',1,'published');`,
    );
  }
  return db;
}

type Hooks = { beforeRemove?: (key: string) => void; afterRemove?: (key: string) => void; onVerify?: () => void };

function port(db: DatabaseSync, removed: string[], hooks: Hooks = {}): StoragePort {
  return {
    verify: () =>
      Promise.resolve().then(() => {
        hooks.onVerify?.();
      }),
    select: (s: Statement) => Promise.resolve().then(() => db.prepare(s.sql).all(...s.params) as unknown[]),
    remove: (key: string) =>
      Promise.resolve().then(() => {
        hooks.beforeRemove?.(key);
        // R2 delete is idempotent, so a retry removing an already-removed key is a no-op, not an error.
        if (!removed.includes(key)) removed.push(key);
        hooks.afterRemove?.(key);
      }),
    batch: (statements: Statement[]) =>
      Promise.resolve().then(() => {
        db.exec("BEGIN");
        try {
          for (const s of statements) db.prepare(s.sql).run(...s.params);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }),
  };
}

const manifest = () => ({
  ...fixtureManifest(),
  operationId: "operation",
  storageIntent: { handles: ["handle1", "handle2"], reference: "intent", expiresAt: Date.now() + 60000 },
});
const HASH = "a".repeat(64);
const rows = (db: DatabaseSync) =>
  db.prepare("SELECT handle,cleanup_state FROM staging_objects ORDER BY handle").all() as {
    handle: string;
    cleanup_state: string;
  }[];
const permits = (db: DatabaseSync) =>
  (db.prepare("SELECT count(*) n FROM settlement_permits").get() as { n: number }).n;

it("deletes both objects and their rows when nothing interrupts", async () => {
  const db = database();
  const removed: string[] = [];
  try {
    const out = await abandonStorage(manifest(), HASH, port(db, removed));
    expect(out.deleted).toBe(2);
    expect(removed.sort()).toEqual(["object1", "object2"]);
    expect(rows(db)).toEqual([]);
    expect(permits(db)).toBe(0);
  } finally {
    db.close();
  }
});

it("leaves the object and a deleting row when it is interrupted before the delete", async () => {
  const db = database();
  const removed: string[] = [];
  try {
    await expect(
      abandonStorage(
        manifest(),
        HASH,
        port(db, removed, {
          beforeRemove: () => {
            throw new Error("interrupted before the object was deleted");
          },
        }),
      ),
    ).rejects.toThrow();

    // Nothing was removed, both rows survive, and both are marked so the debt is visible.
    expect(removed).toEqual([]);
    expect(rows(db)).toEqual([
      { handle: "handle1", cleanup_state: "deleting" },
      { handle: "handle2", cleanup_state: "deleting" },
    ]);
    expect(permits(db)).toBe(0);

    // The retry finishes the job exactly once.
    const out = await abandonStorage(manifest(), HASH, port(db, removed));
    expect(out.deleted).toBe(2);
    expect(removed.sort()).toEqual(["object1", "object2"]);
    expect(rows(db)).toEqual([]);
    expect(permits(db)).toBe(0);
  } finally {
    db.close();
  }
});

it("retains the deleting row as debt when it is interrupted after the delete", async () => {
  const db = database();
  const removed: string[] = [];
  try {
    await expect(
      abandonStorage(
        manifest(),
        HASH,
        port(db, removed, {
          afterRemove: (key) => {
            if (key === "object1") throw new Error("bookkeeping lost after the object was deleted");
          },
        }),
      ),
    ).rejects.toThrow();

    // The object is gone but the row is not, which is the only safe order: a row without an object is
    // recoverable debt, an object without a row is an orphan nothing will ever collect.
    expect(removed).toEqual(["object1"]);
    expect(rows(db)).toEqual([
      { handle: "handle1", cleanup_state: "deleting" },
      { handle: "handle2", cleanup_state: "deleting" },
    ]);
    expect(permits(db)).toBe(0);

    const out = await abandonStorage(manifest(), HASH, port(db, removed));
    expect(out.deleted).toBe(2);
    expect(rows(db)).toEqual([]);
  } finally {
    db.close();
  }
});

it("stops before the next object when the deployment record is replaced mid-action", async () => {
  const db = database();
  const removed: string[] = [];
  try {
    await expect(
      abandonStorage(
        manifest(),
        HASH,
        port(db, removed, {
          afterRemove: (key) => {
            if (key === "object1")
              db.exec("UPDATE recovery_installation SET restore_generation='replaced' WHERE singleton=1");
          },
        }),
      ),
    ).rejects.toThrow();

    // The bookkeeping batch for the first object is fenced by the installation assertion, so the row
    // survives as debt and the second object is never touched.
    expect(removed).toEqual(["object1"]);
    expect(rows(db)).toEqual([
      { handle: "handle1", cleanup_state: "deleting" },
      { handle: "handle2", cleanup_state: "deleting" },
    ]);
    expect(permits(db)).toBe(0);
  } finally {
    db.close();
  }
});

it("refuses a foreign target before selecting or removing anything", async () => {
  const db = database();
  const removed: string[] = [];
  const remove = vi.fn();
  try {
    for (const foreign of [
      { userId: "intruder" },
      { accountId: "other-account" },
      { operationId: "other-operation" },
    ]) {
      await expect(
        abandonStorage({ ...manifest(), ...foreign }, HASH, { ...port(db, removed), remove }),
      ).rejects.toThrow("storage scope refused");
    }
    expect(remove).not.toHaveBeenCalled();
    expect(rows(db)).toEqual([
      { handle: "handle1", cleanup_state: "retained" },
      { handle: "handle2", cleanup_state: "retained" },
    ]);
    expect(permits(db)).toBe(0);
  } finally {
    db.close();
  }
});

it("refuses once the operation is no longer delivery_unknown", async () => {
  const db = database();
  const removed: string[] = [];
  db.exec("UPDATE operations SET state='executed' WHERE id='operation'");
  try {
    await expect(abandonStorage(manifest(), HASH, port(db, removed))).rejects.toThrow();
    expect(removed).toEqual([]);
    // The marking batch rolled back with it, so nothing is left half-administered.
    expect(rows(db)).toEqual([
      { handle: "handle1", cleanup_state: "retained" },
      { handle: "handle2", cleanup_state: "retained" },
    ]);
    expect(permits(db)).toBe(0);
  } finally {
    db.close();
  }
});
