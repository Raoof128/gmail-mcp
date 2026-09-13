import { spawn } from "node:child_process";
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
