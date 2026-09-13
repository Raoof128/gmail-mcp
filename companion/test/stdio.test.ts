import { PassThrough } from "node:stream";
import { it, expect } from "vitest";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { buildCompanionServer } from "../src/server.ts";
it("serves the three tools and logical roots over the actual stdio transport", async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = "";
  output.on("data", (data: Buffer) => {
    wire += data.toString();
  });
  const handle = serveStdio(
    () =>
      buildCompanionServer(false, () => ({
        close() {},
        call: () =>
          Promise.resolve({
            meta: { roots: [{ id: "attachments", write: true, read: false }] },
            body: new Uint8Array(),
          }),
      })),
    { transport: new StdioServerTransport(input, output) },
  );
  try {
    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      }) + "\n",
    );
    await expect.poll(() => wire.includes('"id":1')).toBe(true);
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    await expect.poll(() => wire.includes('"id":2')).toBe(true);
    const list = wire
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((row) => row.id === 2);
    expect(list.result.tools.map((tool: any) => tool.name).sort()).toEqual([
      "list_roots",
      "save_attachment",
      "stage_file",
    ]);
    input.write(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_roots", arguments: {} } }) +
        "\n",
    );
    await expect.poll(() => wire.includes('"id":3')).toBe(true);
    expect(wire).toContain("attachments");
    expect(wire).not.toContain("/Users/");
  } finally {
    await handle.close();
    input.destroy();
    output.destroy();
  }
});
