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

export async function callTool(
  worker: Worker,
  env: Env,
  token: string,
  name: string,
  args: Record<string, unknown>,
  id = 7,
): Promise<{ status: number; json: any; result: any; error: any; isError: boolean }> {
  const res = await rpc(worker, env, token, "tools/call", { name, arguments: args }, id);
  const textBlock = res.json?.result?.content?.find((c: { type: string }) => c.type === "text");
  let result: any = null;
  if (textBlock?.text) {
    try {
      result = JSON.parse(textBlock.text);
    } catch {
      result = textBlock.text;
    }
  }
  // A schema rejection is a tool result with isError and a plain-text message, not a JSON-RPC error,
  // so a caller checking only `error` would read a refusal as a success.
  return {
    status: res.status,
    json: res.json,
    result,
    error: res.json?.error ?? null,
    isError: res.json?.result?.isError === true,
  };
}

export async function modernCall(
  worker: Worker,
  env: Env,
  token: string,
  name: string,
  args: Record<string, unknown>,
  o: {
    capabilities?: Record<string, unknown>;
    inputResponses?: Record<string, unknown>;
    requestState?: string;
    id?: number;
    headers?: Record<string, string | null>;
  } = {},
): Promise<{ status: number; json: any; result: any; error: any; inputRequired: any }> {
  const ctx = createExecutionContext();
  const params: Record<string, unknown> = {
    name,
    arguments: args,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": o.capabilities ?? {},
      "io.modelcontextprotocol/clientInfo": { name: "test-modern", version: "0" },
    },
  };
  if (o.inputResponses) params.inputResponses = o.inputResponses;
  if (o.requestState) params.requestState = o.requestState;
  const headers = new Headers({
    host: new URL(HOST).host,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28",
    // Required by the 2026-07-28 revision on every request; the SDK refuses a modern request without them.
    "mcp-method": "tools/call",
    "mcp-name": name,
    authorization: `Bearer ${token}`,
  });
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (v === null) headers.delete(k);
    else headers.set(k, v);
  }
  const res = await worker.fetch(
    new Request(HOST + "/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: o.id ?? 11, method: "tools/call", params }),
    }),
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
  const r = json?.result;
  const inputRequired = r?.resultType === "input_required" ? r : null;
  const textBlock = r?.content?.find((c: { type: string }) => c.type === "text");
  let result: any = null;
  if (textBlock?.text) {
    try {
      result = JSON.parse(textBlock.text);
    } catch {
      result = textBlock.text;
    }
  }
  return { status: res.status, json, result, error: json?.error ?? null, inputRequired };
}
