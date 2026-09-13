import { McpServer, inputRequired, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { NativeProcess, type NativePort } from "./native.ts";
import { authenticated } from "./auth.ts";
import { StageInput, SaveInput } from "./transfers.ts";
const text = (result: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(result) }] });
export function buildCompanionServer(
  modern = false,
  factory: () => NativePort = () => new NativeProcess(),
  authenticate: typeof authenticated = authenticated,
): McpServer {
  const server = new McpServer({ name: "gmail-mcp-companion", version: "0.0.1" });
  async function run(operation: (native: NativePort) => Promise<unknown>) {
    const native = factory();
    try {
      return text(await operation(native));
    } catch (error) {
      const message =
        error instanceof Error && /^[a-z_]+(?:_[0-9]+)?$/.test(error.message) ? error.message : "companion_failed";
      return { ...text({ error: message }), isError: true };
    } finally {
      native.close();
    }
  }
  server.registerTool(
    "list_roots",
    {
      description: "List owner-configured logical attachment roots and permissions.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run(async (n) => (await n.call({ op: "roots" })).meta),
  );
  server.registerTool(
    "save_attachment",
    {
      description:
        "Verify and save an attachment handle under a writable logical root. Existing destinations are never overwritten.",
      inputSchema: SaveInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => run(async (n) => (await authenticate(n)).save(args)),
  );
  server.registerTool(
    "stage_file",
    {
      description:
        "Stage an immutable snapshot from a readable logical root. Retry the same request after browser approval. Supply a new idempotency_key to deliberately capture a new snapshot.",
      inputSchema: StageInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args, ctx: ServerContext) => {
      const answer = ctx.mcpReq.inputResponses?.approval as { action?: unknown } | undefined;
      if (answer?.action === "decline" || answer?.action === "cancel") return text({ state: "cancelled" });
      const response = await run(async (n) => (await authenticate(n)).stage(args));
      const result = z
        .object({
          state: z.string().optional(),
          pending_id: z.string().optional(),
          approval_url: z.string().optional(),
        })
        .parse(JSON.parse(response.content[0]!.text));
      if (
        modern &&
        result.state === "awaiting_approval" &&
        result.approval_url &&
        server.server.getClientCapabilities()?.elicitation?.url !== undefined
      ) {
        // No client-carried authorization state: every retry recovers the owner-bound journal and Worker approval.
        return inputRequired({
          inputRequests: {
            approval: inputRequired.elicitUrl({
              message: "Approve this attachment snapshot in the Worker.",
              url: result.approval_url,
            }),
          },
        });
      }
      if (
        !modern &&
        result.state === "awaiting_approval" &&
        result.approval_url &&
        server.server.getClientCapabilities()?.elicitation?.url !== undefined
      ) {
        const answer = await ctx.mcpReq.elicitInput({
          mode: "url",
          message: "Approve this attachment snapshot in the Worker.",
          url: result.approval_url,
          elicitationId: result.pending_id ?? "attachment-approval",
        });
        if (answer.action !== "accept") return text({ state: "cancelled" });
        return run(async (n) => (await authenticate(n)).stage(args));
      }
      return response;
    },
  );
  return server;
}
