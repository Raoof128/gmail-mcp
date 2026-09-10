import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../src/env";
import type { WorkerHandler } from "../src/index";
import { HOST } from "./test-env";

type Worker = WorkerHandler;

export async function rpc(
  worker: Worker,
  env: Env,
  token: string | null,
  method: string,
  params: unknown,
  id = 1,
  path = "/mcp",
): Promise<{ status: number; json: any; headers: Headers }> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {
    // The MCP handler applies DNS-rebinding protection and refuses a request with no Host header,
    // which every real HTTP client sends.
    host: new URL(HOST).host,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await worker.fetch(
    new Request(HOST + path, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }),
    { ...env },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let json: any = null;
  if (text.trim().startsWith("{")) json = JSON.parse(text);
  else {
    const line = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("data:"))
      .pop();
    if (line) json = JSON.parse(line.slice(5));
  }
  return { status: res.status, json, headers: res.headers };
}
