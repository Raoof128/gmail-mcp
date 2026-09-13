import { z } from "zod";
export function validateOrigin(origin: string): string {
  const u = new URL(origin);
  if (u.protocol !== "https:" || u.origin !== origin || u.username || u.password) throw new Error("invalid_origin");
  return origin;
}
export function validateCallback(input: string, redirect: string, state: string, issuer: string): string {
  const u = new URL(input),
    expected = new URL(redirect);
  if (u.origin !== expected.origin || u.pathname !== expected.pathname || u.hash) throw new Error("invalid_callback");
  for (const name of ["state", "code", "iss"])
    if (u.searchParams.getAll(name).length !== 1) throw new Error("invalid_callback");
  if (
    u.searchParams.has("error") ||
    u.searchParams.get("state") !== state ||
    u.searchParams.get("iss") !== issuer ||
    !u.searchParams.get("code")
  )
    throw new Error("invalid_callback");
  return u.searchParams.get("code")!;
}
export async function boundedBody(response: Response, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > maximum) throw new Error("response_size");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
export class Authority {
  readonly origin: string;
  private readonly fetcher: typeof fetch;
  constructor(origin: string, fetcher: typeof fetch = fetch) {
    this.origin = validateOrigin(origin);
    this.fetcher = fetcher;
  }
  async request(path: string, token: string | null, init: RequestInit = {}, timeout = 30_000): Promise<Response> {
    if (!/^\/[A-Za-z0-9_./-]*(?:\?[A-Za-z0-9%=&_.-]*)?$/.test(path) || path.startsWith("//"))
      throw new Error("invalid_route");
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error("invalid_route");
    const headers = new Headers(init.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    return this.fetcher(url, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(timeout) });
  }
  async json(path: string, token: string | null, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(path, token, init);
    const bytes = await boundedBody(response, 65536);
    if (!response.ok) throw new Error(`authority_${response.status}`);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
  }
  async discover(): Promise<void> {
    const d = z
      .object({
        issuer: z.string(),
        authorization_endpoint: z.string(),
        token_endpoint: z.string(),
        revocation_endpoint: z.string(),
        authorization_response_iss_parameter_supported: z.literal(true),
      })
      .parse(await this.json("/.well-known/oauth-authorization-server", null));
    if (
      d.issuer !== this.origin ||
      d.authorization_endpoint !== this.origin + "/authorize" ||
      d.token_endpoint !== this.origin + "/token" ||
      d.revocation_endpoint !== this.origin + "/token"
    )
      throw new Error("issuer_or_endpoint_mismatch");
  }
}
export const Credentials = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_at: z.number(),
  scope: z.literal("staging"),
});
export type Credentials = z.infer<typeof Credentials>;
export const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  token_type: z.string().refine((v) => v.toLowerCase() === "bearer"),
  scope: z.literal("staging"),
});
