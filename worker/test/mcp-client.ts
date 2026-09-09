import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";

export async function rpc(
  env: unknown,
  token: string | null,
  method: string,
  params: unknown,
  id = 1,
): Promise<{ status: number; json: any }> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await worker.fetch(
    new Request("https://x.test/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
    env as any,
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
  return { status: res.status, json };
}
