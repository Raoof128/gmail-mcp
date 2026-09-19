#!/usr/bin/env node
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { NativeProcess } from "./native.ts";
import { login, logout } from "./auth.ts";
import { buildCompanionServer } from "./server.ts";
type DebtRow = {
  scope: string;
  handle: string;
  state: string;
  root: string;
  relative: string;
  bytes: number;
  temporary: string;
  releasable: boolean;
};
async function main() {
  const command = process.argv[2] ?? "serve";
  if (command === "serve") {
    serveStdio((ctx) => buildCompanionServer(ctx.era === "modern"));
    return;
  }
  if (command === "login") {
    await login();
    process.stderr.write("Companion login saved in Keychain.\n");
    return;
  }
  if (command === "logout") {
    const revoked = await logout();
    process.stderr.write(
      revoked
        ? "Logged out; remote revocation confirmed.\n"
        : "Logged out locally; remote revocation is unconfirmed.\n",
    );
    return;
  }
  if (command === "init") {
    const { values } = parseArgs({
      args: process.argv.slice(3),
      options: {
        origin: { type: "string" },
        "client-id": { type: "string" },
        "read-root": { type: "string", multiple: true },
        "write-root": { type: "string" },
      },
    });
    if (!values.origin || !values["client-id"]) throw new Error("usage");
    const roots: Record<string, { path: string; read: boolean; write: boolean }> = {
      attachments: {
        path: resolve(values["write-root"] ?? homedir() + "/Downloads/Gmail MCP"),
        read: false,
        write: true,
      },
    };
    for (const item of values["read-root"] ?? []) {
      const split = item.indexOf("=");
      if (split < 1) throw new Error("usage");
      const id = item.slice(0, split);
      if (roots[id]) throw new Error("duplicate_root");
      roots[id] = { path: resolve(item.slice(split + 1)), read: true, write: false };
    }
    const native = new NativeProcess(true);
    try {
      await native.call({ origin: values.origin, client_id: values["client-id"], roots });
    } finally {
      native.close();
    }
    process.stderr.write("Companion configuration created. Run login, then serve.\n");
    return;
  }
  if (command === "debt") {
    const { values } = parseArgs({
      args: process.argv.slice(3),
      options: { release: { type: "string" }, scope: { type: "string" } },
    });
    const native = new NativeProcess();
    try {
      if (values.release !== undefined) {
        // The reservation id is a digest of scope and handle and cannot be inverted, so the scope
        // has to be named. It is never a constant: it is a hash of origin, client and owner.
        if (!values.scope) throw new Error("usage");
        const { outcome } = (await native.call({ op: "debt.release", scope: values.scope, handle: values.release }))
          .meta as { outcome: string };
        process.stdout.write(
          { released: "Released.\n", no_such_receipt: "No such receipt.\n", not_charged: "Nothing charged.\n" }[
            outcome
          ] ?? `Unexpected outcome: ${outcome}\n`,
        );
        return;
      }
      const { rows } = (await native.call({ op: "debt.list" })).meta as { rows: DebtRow[] };
      if (rows.length === 0) {
        process.stdout.write("No charged save debt.\n");
        return;
      }
      for (const row of rows) {
        const remedy = row.releasable
          ? `run: gmail-mcp-companion debt --scope ${row.scope} --release ${row.handle}`
          : row.temporary === "present"
            ? "start the companion; the helper collects this safely on startup"
            : `not clearable: state ${row.state}, temporary ${row.temporary}`;
        process.stdout.write(
          `${row.handle}  ${row.state}  ${row.bytes} bytes  ${row.root}/${row.relative}\n  ${remedy}\n`,
        );
      }
    } catch (error) {
      // A refusal carries the native code. Without this it reaches the owner as the generic
      // "check configuration, permissions, login and the native build", which is the wrong
      // sentence for the one case they most need to understand.
      const code = error instanceof Error ? error.message : "native_failed";
      if (!/^[a-z_]+$/.test(code)) throw error;
      process.stdout.write(`Refused: ${code}\n`);
      process.exitCode = 1;
    } finally {
      native.close();
    }
    return;
  }
  throw new Error("usage");
}
main().catch(() => {
  process.stderr.write(
    "Companion command failed. Check configuration, permissions, login and the native build.\nUsage: gmail-mcp-companion init --origin https://HOST --client-id ID [--read-root ID=PATH] [--write-root PATH] | login | logout | serve | debt [--scope SCOPE --release HANDLE]\n",
  );
  process.exitCode = 1;
});
