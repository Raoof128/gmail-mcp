import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Deps } from "../deps";
import type { Env } from "../env";
import { getAccessToken } from "./tokens";

export const GMAIL = {
  api: "https://gmail.googleapis.com/gmail/v1/users/me/",
  upload: "https://gmail.googleapis.com/upload/gmail/v1/users/me/",
  resumable: "https://gmail.googleapis.com/resumable/upload/gmail/v1/users/me/",
} as const;

const MAX_TRIES = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;

export type GmailAccount = { userId: string; accountId: string };
export type Upload =
  | { kind: "media"; contentType: string; bytes: Uint8Array }
  | { kind: "multipart"; contentType: string; bytes: Uint8Array; metadata: Record<string, unknown> };
export type GmailRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | string[] | number | boolean | undefined>;
  json?: unknown;
  upload?: Upload;
  /** `resumable` targets the session host; the plain API host otherwise. */
  base?: "api" | "resumable";
  headers?: Record<string, string>;
  /** `safe` may be re-sent after a transient failure; `none` is opened once (spec 3.9). */
  retry: "safe" | "none";
};

export class GmailApiError extends GmailMcpError {
  constructor(
    public readonly status: number,
    public readonly googleMessage: string,
    public readonly reason: string | null,
  ) {
    super("gmail_error", `gmail_error: ${status} ${googleMessage}`, { status, reason });
    this.name = "GmailApiError";
  }
}

type GoogleErrorBody = { error?: { message?: string; errors?: { reason?: string }[]; status?: string } };

async function readError(res: Response): Promise<{ message: string; reason: string | null }> {
  const body = (await res.json().catch(() => ({}))) as GoogleErrorBody;
  return {
    message: body.error?.message ?? res.statusText ?? `HTTP ${res.status}`,
    reason: body.error?.errors?.[0]?.reason ?? null,
  };
}

export function buildUrl(base: string, path: string, query?: GmailRequest["query"]): string {
  const u = new URL(path, base);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, item);
    else u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** Copies into an ArrayBuffer-backed view: fetch's BodyInit refuses ArrayBufferLike-backed typed arrays. */
function bodyOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  out.set(bytes);
  return out;
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function backoffMs(attempt: number): number {
  // Full jitter over an exponential window, capped. attempt is 1-based.
  const window = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.floor(window / 2 + Math.random() * (window / 2));
}

export async function isRateLimited(res: Response): Promise<boolean> {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  const { reason } = await readError(res.clone());
  return reason === "rateLimitExceeded" || reason === "userRateLimitExceeded";
}

async function once(
  deps: Deps,
  token: string,
  o: GmailRequest,
  target: { url: string; init: Omit<RequestInit, "headers"> & { headers: Record<string, string> } },
): Promise<Response> {
  return deps.googleFetch(target.url, {
    ...target.init,
    headers: { ...target.init.headers, authorization: `Bearer ${token}` },
  });
}

function plainTarget(o: GmailRequest) {
  const extra = o.headers ?? {};
  if (o.upload?.kind === "multipart") {
    const b = `=_meta_${crypto.randomUUID()}`;
    const enc = new TextEncoder();
    const head = enc.encode(
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(o.upload.metadata)}\r\n--${b}\r\nContent-Type: ${o.upload.contentType}\r\n\r\n`,
    );
    const tail = enc.encode(`\r\n--${b}--\r\n`);
    const body = new Uint8Array(new ArrayBuffer(head.byteLength + o.upload.bytes.byteLength + tail.byteLength));
    body.set(head, 0);
    body.set(o.upload.bytes, head.byteLength);
    body.set(tail, head.byteLength + o.upload.bytes.byteLength);
    return {
      url: buildUrl(GMAIL.upload, o.path, { ...o.query, uploadType: "multipart" }),
      init: { method: o.method, headers: { ...extra, "content-type": `multipart/related; boundary=${b}` }, body },
    };
  }
  if (o.upload?.kind === "media") {
    return {
      url: buildUrl(GMAIL.upload, o.path, { ...o.query, uploadType: "media" }),
      init: {
        method: o.method,
        headers: { ...extra, "content-type": o.upload.contentType },
        body: bodyOf(o.upload.bytes),
      },
    };
  }
  const base = o.base === "resumable" ? GMAIL.resumable : GMAIL.api;
  return {
    url: buildUrl(base, o.path, o.query),
    init:
      o.json === undefined
        ? { method: o.method, headers: { ...extra } as Record<string, string> }
        : {
            method: o.method,
            headers: { ...extra, "content-type": "application/json" },
            body: JSON.stringify(o.json),
          },
  };
}

/**
 * Spec 3.9 and nothing else. 401: refresh once, retry once. 429 and rate-limit 403: backoff with jitter,
 * Retry-After honoured, at most three tries. 5xx: the same, but only while `retry` is `safe`; a request
 * with a body that may have reached Gmail is never re-sent, and the caller decides what the failure means.
 */
export async function gmailFetch(env: Env, deps: Deps, acct: GmailAccount, o: GmailRequest): Promise<Response> {
  let token = await getAccessToken(env, deps, acct.userId, acct.accountId);
  let refreshed = false;
  for (let attempt = 1; ; attempt++) {
    const res = await once(deps, token, o, plainTarget(o));
    if (res.ok) return res;
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      token = await getAccessToken(env, deps, acct.userId, acct.accountId, { forceRefresh: true });
      continue;
    }
    const transient = (await isRateLimited(res)) || res.status >= 500;
    if (transient && o.retry === "safe" && attempt < MAX_TRIES) {
      await deps.sleep(retryAfterMs(res) ?? backoffMs(attempt));
      continue;
    }
    const { message, reason } = await readError(res);
    throw new GmailApiError(res.status, message, reason);
  }
}

export async function gmailJson<T>(env: Env, deps: Deps, acct: GmailAccount, o: GmailRequest): Promise<T> {
  const res = await gmailFetch(env, deps, acct, o);
  if (res.status === 204) return undefined as T;
  return res.json<T>();
}

/**
 * Half one of the resumable protocol: the session. It moves no message bytes, so it is retried like any
 * read (spec 3.9 "5xx before the send body"). Google's recovery (query the session, resume at the
 * confirmed offset) is not built: the URL lives only in this call's stack frame.
 */
export async function openResumableSession(
  env: Env,
  deps: Deps,
  acct: GmailAccount,
  o: { path: string; contentType: string; length: number; metadata?: Record<string, unknown> },
): Promise<string> {
  const res = await gmailFetch(env, deps, acct, {
    method: "POST",
    path: o.path,
    base: "resumable",
    query: { uploadType: "resumable" },
    headers: { "x-upload-content-type": o.contentType, "x-upload-content-length": String(o.length) },
    json: o.metadata ?? {},
    retry: "safe",
  });
  const location = res.headers.get("location");
  if (!location) throw new GmailApiError(res.status, "resumable session without Location", null);
  return location;
}

/** Half two: the bytes. Opened exactly once; a failure here is the caller's to classify. */
export async function putResumable(
  env: Env,
  deps: Deps,
  acct: GmailAccount,
  sessionUrl: string,
  o: { contentType: string; length: number; body: ReadableStream<Uint8Array> },
): Promise<Response> {
  const token = await getAccessToken(env, deps, acct.userId, acct.accountId);
  const res = await deps.googleFetch(sessionUrl, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": o.contentType },
    body: o.body.pipeThrough(new FixedLengthStream(o.length)),
  });
  if (res.ok) return res;
  const { message, reason } = await readError(res);
  throw new GmailApiError(res.status, message, reason);
}
