import type { Env } from "../env";
import type { Deps } from "../deps";
import type { Binding, Deadlines, HttpObservation, Lease } from "../operations/recovery-types";
import { admitRequest, recoveryFences, recoveryRow } from "../operations/recovery-admission";
import { getAccessTokenPinned } from "./tokens";
import { validateSessionUrl } from "./resumable";
import { GOOGLE } from "./oidc";
import { hashCanonical } from "../crypto/canonical";

export function retryAtFor(header: string | null, now: number, attempt: number): number {
  const local = now + Math.min(1800000, 300000 * 2 ** Math.min(Math.max(0, attempt - 1), 3));
  if (!header) return local;
  let at: number;
  if (/^\d+$/.test(header.trim())) {
    const secs = Number(header.trim());
    at = now + secs * 1000;
    if (!Number.isSafeInteger(secs) || !Number.isSafeInteger(at)) return local;
  } else if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header))
    at = Date.parse(header);
  else return local;
  return Number.isFinite(at) ? Math.max(local, at) : local;
}
class Refusal extends Error {
  constructor(readonly observation: HttpObservation) {
    super("recovery transport refused");
  }
}
async function allowed(
  env: Env,
  b: Binding,
  lease: Lease,
  request: { kind: "gmail" | "refresh"; url: string; init: RequestInit },
): Promise<boolean> {
  if (request.kind === "refresh")
    return (
      request.url === GOOGLE.tokenUrl &&
      request.init.method === "POST" &&
      request.init.body instanceof URLSearchParams &&
      request.init.body.toString().length <= 16384
    );
  if (request.init.method === "PUT") {
    if (lease.mode !== "send_session_status" || b.mimeLength === null || request.init.body != null) return false;
    validateSessionUrl(request.url, { kind: "send" });
    const row = await recoveryRow(env.DB, b.operationId);
    const h = new Headers(request.init.headers);
    return (
      row?.session_digest === (await hashCanonical(request.url)) &&
      h.get("content-length") === "0" &&
      h.get("content-range") === `bytes */${b.mimeLength}`
    );
  }
  if (
    request.init.method !== "GET" ||
    request.init.body != null ||
    lease.mode !== "generated_search" ||
    b.executor === "send_draft"
  )
    return false;
  const u = new URL(request.url);
  if (u.origin !== "https://gmail.googleapis.com" || u.hash || u.username || u.password) return false;
  if (u.pathname === "/gmail/v1/users/me/messages")
    return (
      [...u.searchParams.keys()].sort().join(",") === "labelIds,maxResults,q" &&
      u.searchParams.get("q") === `rfc822msgid:${b.generatedMessageId}` &&
      u.searchParams.get("labelIds") === "SENT" &&
      u.searchParams.get("maxResults") === "2"
    );
  return (
    /^\/gmail\/v1\/users\/me\/messages\/[A-Za-z0-9_-]{1,256}$/.test(u.pathname) &&
    [...u.searchParams.keys()].sort().join(",") === "format,metadataHeaders" &&
    u.searchParams.get("format") === "metadata" &&
    u.searchParams.get("metadataHeaders") === "Message-ID"
  );
}
/** Every fetch, including token refresh and a 401 repeat, passes the same durable admission gate. */
export async function recoveryRequest(
  env: Env,
  deps: Deps,
  b: Binding,
  lease: Lease,
  deadlines: Deadlines,
  request: { kind: "gmail" | "refresh"; url: string; init: RequestInit },
): Promise<HttpObservation> {
  const deferred = (reason: "budget" | "transport"): HttpObservation => ({
    kind: "deferred",
    retryAt: Date.now() + 300000,
    reason,
  });
  try {
    if (!(await allowed(env, b, lease, request))) return { kind: "suspended", reason: "disabled" };
    const fetchOne = async (init: RequestInit): Promise<HttpObservation> => {
      const now = Date.now();
      const until = Math.min(deadlines.requestUntil, deadlines.attemptUntil, deadlines.runUntil, now + 15000);
      if (!(await admitRequest(env, b, lease, { ...deadlines, requestUntil: until }, request.kind, now))) {
        try {
          await env.DB.batch(recoveryFences(env, b, lease, now));
        } catch {
          return { kind: "suspended", reason: "disabled" };
        }
        return deferred("budget");
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            controller.abort();
            reject(new Error("deadline"));
          },
          Math.max(0, until - Date.now()),
        );
      });
      try {
        const response = await Promise.race([
          deps.googleFetch(request.url, { ...init, redirect: "manual", signal: controller.signal }),
          timeout,
        ]);
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (response.body) {
          reader = response.body.getReader();
          for (;;) {
            const { done, value } = await Promise.race([reader.read(), timeout]);
            if (done) break;
            size += value.length;
            if (size > 65536) throw new Error("body bound");
            chunks.push(value);
          }
        }
        if (Date.now() >= until) throw new Error("deadline");
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return {
          kind: "response",
          status: response.status,
          bytes,
          range: response.headers.get("range"),
          retryAfter: response.headers.get("retry-after"),
        };
      } catch {
        controller.abort();
        if (reader) void reader.cancel().catch(() => undefined);
        return deferred("transport");
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    if (request.kind === "refresh") return await fetchOne(request.init);
    const pinnedDeps: Deps = {
      ...deps,
      googleFetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const observation = await recoveryRequest(env, deps, b, lease, deadlines, {
          kind: "refresh",
          url,
          init: init ?? {},
        });
        if (observation.kind !== "response") throw new Refusal(observation);
        if (observation.status === 429 || observation.status >= 500)
          throw new Refusal({
            kind: "deferred",
            reason: "transport",
            retryAt: retryAtFor(observation.retryAfter, Date.now(), 1),
          });
        return new Response(new Uint8Array(observation.bytes), {
          status: observation.status,
          headers: { "content-type": "application/json" },
        });
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getAccessTokenPinned(env, pinnedDeps, b.userId, b.accountId, {
        expectedVersion: b.credentialVersion,
        forceRefresh: attempt === 1,
      });
      const headers = new Headers(request.init.headers);
      headers.set("authorization", `Bearer ${token}`);
      const result = await fetchOne({ ...request.init, headers });
      if (result.kind !== "response" || result.status !== 401 || attempt === 1) return result;
    }
    return deferred("transport");
  } catch (error) {
    if (error instanceof Refusal) return error.observation;
    // Never serialize provider/fetch errors: they may contain a token-bearing session URI.
    return { kind: "suspended", reason: "account_changed" };
  }
}
