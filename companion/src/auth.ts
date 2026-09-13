import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { Authority, Credentials, TokenResponse, validateCallback } from "./http.ts";
import { NativeProcess, type NativePort } from "./native.ts";
import { Companion } from "./transfers.ts";
const configSchema = z.object({ origin: z.string(), client_id: z.string() });
const epochSchema = z.object({ epoch: z.string() });
export async function authenticated(native: NativePort): Promise<Companion> {
  const config = configSchema.parse((await native.call({ op: "config" })).meta),
    api = new Authority(config.origin);
  const begin = await native.call({ op: "auth.begin" });
  const { epoch } = epochSchema.parse(begin.meta);
  if (!begin.body.length) throw new Error("login_required");
  let credentials = Credentials.parse(JSON.parse(new TextDecoder().decode(begin.body)));
  if (credentials.expires_at <= Date.now() + 60_000) {
    await api.discover();
    const tokens = TokenResponse.parse(
      await api.json("/token", null, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credentials.refresh_token,
          client_id: config.client_id,
          resource: config.origin + "/staging",
          scope: "staging",
        }),
      }),
    );
    credentials = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? credentials.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
      scope: "staging",
    };
    await native.call({ op: "auth.commit", epoch }, new TextEncoder().encode(JSON.stringify(credentials)));
  }
  const owner = z
    .object({ user_id: z.string().min(1) })
    .parse(await api.json("/staging/identity", credentials.access_token));
  return new Companion(native, api, credentials.access_token, { ...owner, client_id: config.client_id });
}
function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", [url], { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
    child.on("error", () => reject(new Error("browser_failed")));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("browser_failed"))));
  });
}
export async function login(): Promise<void> {
  const native = new NativeProcess();
  let config: z.infer<typeof configSchema>, epoch: string;
  try {
    config = configSchema.parse((await native.call({ op: "config" })).meta);
    epoch = epochSchema.parse((await native.call({ op: "auth.begin" })).meta).epoch;
  } finally {
    native.close();
  }
  const api = new Authority(config.origin);
  await api.discover();
  const state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  let redirect = "";
  let accept!: (code: string) => void;
  const codePromise = new Promise<string>((resolve) => {
    accept = resolve;
  });
  const server = createServer((req, res) => {
    try {
      if (req.method !== "GET" || req.headers.host !== new URL(redirect).host || (req.url?.length ?? 0) > 8192)
        throw new Error("callback");
      const code = validateCallback(new URL(req.url ?? "", redirect).href, redirect, state, api.origin);
      res.writeHead(200, {
        "content-type": "text/plain",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'",
      });
      res.end("Login complete. You can close this window.");
      accept(code);
    } catch {
      res.writeHead(400, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("Invalid callback.");
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 20;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback_failed");
    redirect = `http://127.0.0.1:${address.port}/callback`;
    const url = new URL("/authorize", api.origin);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: config.client_id,
      redirect_uri: redirect,
      scope: "staging",
      resource: api.origin + "/staging",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    await openBrowser(url.href);
    const code = await Promise.race([
      codePromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("login_timeout")), 5 * 60_000);
      }),
    ]);
    const tokens = TokenResponse.parse(
      await api.json("/token", null, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.client_id,
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
          resource: api.origin + "/staging",
        }),
      }),
    );
    if (!tokens.refresh_token) throw new Error("refresh_token_missing");
    const credentials: Credentials = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
      scope: "staging",
    };
    const commit = new NativeProcess();
    try {
      await commit.call({ op: "auth.commit", epoch }, new TextEncoder().encode(JSON.stringify(credentials)));
    } finally {
      commit.close();
    }
  } finally {
    if (timer) clearTimeout(timer);
    server.closeAllConnections();
    server.close();
  }
}
export async function logout(): Promise<boolean> {
  const native = new NativeProcess();
  try {
    const config = configSchema.parse((await native.call({ op: "config" })).meta),
      begin = await native.call({ op: "auth.begin" });
    // Local invalidation precedes network revocation, including when the authority is unavailable.
    await native.call({ op: "auth.logout" });
    if (!begin.body.length) return true;
    try {
      const credentials = Credentials.parse(JSON.parse(new TextDecoder().decode(begin.body))),
        api = new Authority(config.origin);
      await api.discover();
      const response = await api.request("/token", null, {
        method: "POST",
        body: new URLSearchParams({
          token: credentials.refresh_token,
          token_type_hint: "refresh_token",
          client_id: config.client_id,
        }),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  } finally {
    native.close();
  }
}
