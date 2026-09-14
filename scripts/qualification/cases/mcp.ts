import { z } from "zod";
import type { Manifest } from "../manifest.ts";
/** Real Worker adapter. It neither retries mutations nor accepts a caller-supplied recipient list. */
export class QualificationMcp {
  private nextId = 1;
  constructor(
    private readonly manifest: Manifest,
    private readonly credential: () => string,
    private readonly transport: typeof fetch = fetch,
  ) {}
  async read(name: "get_message" | "get_thread" | "search_threads", args: Record<string, unknown>): Promise<unknown> {
    return this.call(name, { ...args, account: this.manifest.accountAlias });
  }
  async sendFixture(runId: string, index: number): Promise<unknown> {
    const auth = this.manifest.authorization;
    if (
      !auth ||
      auth.expiresAt <= Date.now() ||
      !auth.capabilities.includes("send") ||
      this.manifest.profile !== "scratch" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(runId) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= 3
    )
      throw new Error("fixture authorization refused");
    return this.call("send_message", {
      account: this.manifest.accountAlias,
      from: auth.sender,
      to: [auth.recipient],
      cc: [],
      bcc: [],
      subject: `Recovery qualification ${runId} ${index}`,
      body: "Approved disposable recovery qualification fixture.",
      idempotency_key: `qualification:${runId}:${index}`,
    });
  }
  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.manifest.accountAlias) throw new Error("verified account alias required");
    const token = this.credential();
    if (!token || /\s/.test(token)) throw new Error("credential unavailable");
    const id = this.nextId++;
    const response = await this.transport(this.manifest.origin + "/mcp", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(45000),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    });
    if (
      response.headers.get("x-recovery-build") !== this.manifest.workerBuildId ||
      response.headers.get("x-recovery-version") !== this.manifest.deploymentVersionId
    ) {
      await response.body?.cancel();
      throw new Error("serving identity changed");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("fixture request failed");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("fixture response unavailable");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.byteLength;
        if (length > 65536) throw new Error("fixture response too large");
        chunks.push(item.value);
      }
    } catch {
      await reader.cancel().catch(() => undefined);
      throw new Error("fixture response unavailable");
    } finally {
      reader.releaseLock();
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const json = text.trim().startsWith("{")
      ? text
      : text
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .at(-1)
          ?.slice(5);
    const rpc = z
      .object({
        jsonrpc: z.literal("2.0"),
        id: z.number(),
        result: z.object({
          isError: z.boolean().optional(),
          content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
        }),
      })
      .parse(JSON.parse(json ?? "null"));
    if (rpc.id !== id || rpc.result.isError) throw new Error("fixture tool refused");
    const result = rpc.result.content.find((c) => c.type === "text")?.text;
    if (!result) throw new Error("fixture result missing");
    return JSON.parse(result) as unknown;
  }
}
