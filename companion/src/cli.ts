#!/usr/bin/env node
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { NativeProcess } from "./native.ts";
import { login, logout } from "./auth.ts";
import { buildCompanionServer } from "./server.ts";
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
  throw new Error("usage");
}
main().catch(() => {
  process.stderr.write(
    "Companion command failed. Check configuration, permissions, login and the native build.\nUsage: gmail-mcp-companion init --origin https://HOST --client-id ID [--read-root ID=PATH] [--write-root PATH] | login | logout | serve\n",
  );
  process.exitCode = 1;
});
