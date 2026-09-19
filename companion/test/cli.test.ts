import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { it, expect } from "vitest";

it("launches the CLI directly in Node and lists tools without accessing credentials", async () => {
  const child = spawn(process.execPath, [new URL("../src/cli.ts", import.meta.url).pathname, "serve"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data: Buffer) => {
    stdout += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cli-test", version: "1" } },
      }) + "\n",
    );
    await expect.poll(() => stdout.includes('"id":1')).toBe(true);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    await expect.poll(() => stdout.includes('"id":2')).toBe(true);
    const reply = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((row) => row.id === 2);
    expect(reply.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      "list_roots",
      "save_attachment",
      "stage_file",
    ]);
    expect(stderr).toBe("");
  } finally {
    child.kill();
  }
});

const nativeBinary = new URL("../native/.build/release/gmail-mcp-native", import.meta.url).pathname;

// Integration, not hermetic: this drives the real helper against this machine's own journal. The
// helper resolves its state directory from $HOME as a security boundary and deliberately offers no
// override, so making this isolated would mean weakening that. npm run verify does not build Swift,
// so the case skips rather than making the TypeScript gate depend on a release build; the native
// suite is the authority for the behaviour and this only proves the wiring.
it.skipIf(!existsSync(nativeBinary))("debt lists charged debt and refuses a handle that is not there", () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  // The helper takes an exclusive lock and its waiter blocks, so a save in flight makes this wait.
  // Never spawn it without a timeout.
  const list = spawnSync(process.execPath, [cli, "debt"], { encoding: "utf8", timeout: 60_000 });
  expect(list.error).toBeUndefined();
  expect(list.status).toBe(0);
  // Either nothing is charged, or every row prints the exact command that clears it.
  expect(list.stdout).toMatch(/^No charged save debt\.\n$|--scope \S+ --release \S+/);

  const bogus = spawnSync(process.execPath, [cli, "debt", "--scope", "nosuchscope", "--release", "nosuchhandle"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(bogus.error).toBeUndefined();
  expect(bogus.stdout).toBe("No such receipt.\n");
});
