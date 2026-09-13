import { it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { buildCompanionServer } from "../src/server.ts";
import type { authenticated } from "../src/auth.ts";
const pending = {
  state: "awaiting_approval",
  pending_id: "pa-test",
  approval_url: "https://worker.example.test/approve/pa-test",
};
it("uses URL input requests for modern clients and text links without that capability", async () => {
  const registration = vi.spyOn(McpServer.prototype, "registerTool");
  const authenticate = (() =>
    Promise.resolve({ stage: () => Promise.resolve(pending) })) as unknown as typeof authenticated;
  try {
    const server = buildCompanionServer(
      true,
      () => ({ close() {}, call: () => Promise.resolve({ meta: {}, body: new Uint8Array() }) }),
      authenticate,
    );
    const capability = vi.spyOn(server.server, "getClientCapabilities").mockReturnValue({ elicitation: { url: {} } });
    const handler = registration.mock.calls.find((row) => row[0] === "stage_file")![2] as any;
    const modern = await handler({}, { mcpReq: {} });
    expect(modern.inputRequests.approval).toMatchObject({
      method: "elicitation/create",
      params: { mode: "url", url: pending.approval_url },
    });
    capability.mockReturnValue({});
    const fallback = await handler({}, { mcpReq: {} });
    expect(JSON.parse(fallback.content[0].text)).toEqual(pending);
  } finally {
    vi.restoreAllMocks();
  }
});
it("treats legacy client acceptance as continuation rather than Worker approval", async () => {
  const registration = vi.spyOn(McpServer.prototype, "registerTool");
  let stages = 0;
  const authenticate = (() =>
    Promise.resolve({
      stage: () => {
        stages++;
        return Promise.resolve(pending);
      },
    })) as unknown as typeof authenticated;
  try {
    const server = buildCompanionServer(
      false,
      () => ({ close() {}, call: () => Promise.resolve({ meta: {}, body: new Uint8Array() }) }),
      authenticate,
    );
    vi.spyOn(server.server, "getClientCapabilities").mockReturnValue({ elicitation: { url: {} } });
    const handler = registration.mock.calls.find((row) => row[0] === "stage_file")![2] as any;
    const result = await handler({}, { mcpReq: { elicitInput: () => Promise.resolve({ action: "accept" }) } });
    expect(stages).toBe(2);
    expect(JSON.parse(result.content[0].text)).toEqual(pending);
  } finally {
    vi.restoreAllMocks();
  }
});
