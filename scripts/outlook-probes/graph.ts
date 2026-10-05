import { redact, shapePath } from "./redact.ts";

export const GRAPH_ORIGIN = "https://graph.microsoft.com";
const ME = "/v1.0/me";
const IMMUTABLE = 'IdType="ImmutableId"';
/** Upload sessions are documented on outlook.office.com. P8 records what the service actually returns. */
const UPLOAD_HOSTS = new Set(["outlook.office.com", "outlook.office365.com"]);
/** Headers worth keeping as evidence. Everything else is dropped. */
const KEPT_HEADERS = ["preference-applied", "retry-after", "content-type", "content-length", "location"];

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

export interface Gate {
  /** POST and PATCH, which change the mailbox. */
  allowMutation: boolean;
  /** DELETE on a message, and only one this run created. */
  allowDestructive: boolean;
}

export interface Exchange {
  transport: "graph" | "upload";
  method: string;
  path: string;
  status: number;
  ms: number;
  headers: Record<string, string>;
  error?: { code: string; message: string };
}

export interface GraphResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}

/** DELETE routes that hold no mail and that the probes use to clean up after themselves. */
const CLEANUP_DELETE = [
  /^\/v1\.0\/me\/outlook\/masterCategories\/[^/]+$/,
  /^\/v1\.0\/me\/mailFolders\/inbox\/messageRules\/[^/]+$/,
];
const MESSAGE_DELETE = /^\/v1\.0\/me\/messages\/([^/]+)$/;

/**
 * The one decision about whether a Graph request may leave this process. It mirrors the Worker's
 * planned allowlist in spirit and is stricter where probes need less: no permanent delete under any
 * prefix, no other user's mailbox, no beta, no batch, and DELETE only where a probe has said why.
 */
export function checkRoute(method: Method, rawPath: string, gate: Gate, created: ReadonlySet<string>): void {
  // Decide on the decoded form, so percent-encoding cannot smuggle a refused segment past the checks.
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    throw new Refused("path is not valid percent-encoding");
  }
  const lower = path.toLowerCase();
  if (lower.includes("permanentdelete")) throw new Refused("permanentDelete is never sent");
  // An encoded slash or a dot segment could climb out of /me once the service decodes the path.
  if (/%2f/i.test(rawPath) || path.split("/").some((seg) => seg === "." || seg === "..")) {
    throw new Refused("encoded slashes and dot segments are never sent");
  }
  if (!(path === ME || path.startsWith(`${ME}/`) || path.startsWith(`${ME}?`))) {
    throw new Refused(`only ${ME} paths are sent, not ${shapePath(path)}`);
  }
  if (lower.includes("$batch")) throw new Refused("$batch is never sent");
  if (method === "GET") return;
  if (!gate.allowMutation) throw new Refused(`${method} needs --allow-mutation`);
  if (method !== "DELETE") return;
  const bare = path.split("?", 1)[0] ?? "";
  if (CLEANUP_DELETE.some((r) => r.test(bare))) return;
  const m = MESSAGE_DELETE.exec(bare);
  if (m?.[1] != null && gate.allowDestructive && created.has(m[1])) return;
  throw new Refused(`DELETE ${shapePath(bare)} is not allowed`);
}

export interface CallOptions {
  body?: unknown;
  /** Extra preferences, joined to the immutable-id preference in one Prefer header. */
  prefer?: string[];
  headers?: Record<string, string>;
}

export class GraphClient {
  /** Ids of items this run created. Only these can ever be the target of a message DELETE. */
  readonly created = new Set<string>();
  readonly exchanges: Exchange[] = [];

  constructor(
    private readonly token: () => Promise<string>,
    private readonly gate: Gate,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** `path` is either `/v1.0/me/...` or an absolute Graph URL such as a nextLink or deltaLink. */
  async call(method: Method, path: string, opts: CallOptions = {}): Promise<GraphResponse> {
    const url = new URL(path, GRAPH_ORIGIN);
    if (url.origin !== GRAPH_ORIGIN) throw new Refused(`host ${url.host} is not Graph`);
    const relative = `${url.pathname}${url.search}`;
    checkRoute(method, url.pathname, this.gate, this.created);
    const prefer = opts.prefer ?? [];
    if (prefer.some((p) => p.toLowerCase().includes("allow-unsafe-html"))) {
      throw new Refused("unsafe HTML is never requested");
    }
    const headers: Record<string, string> = {
      ...opts.headers,
      authorization: `Bearer ${await this.token()}`,
      prefer: [IMMUTABLE, ...prefer].join(", "),
      accept: "application/json",
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const started = Date.now();
    const res = await this.fetchImpl(url, { method, headers, ...(body === undefined ? {} : { body }) });
    const parsed = await readBody(res);
    this.exchanges.push(exchange("graph", method, relative, res, Date.now() - started, parsed));
    return { status: res.status, headers: res.headers, body: parsed };
  }

  /**
   * Sends one upload-session request. The URL is a bearer credential, so it is checked, used and never
   * recorded except as a shape, and the Graph token is never attached: the documentation says not to.
   */
  async upload(
    method: "PUT" | "DELETE",
    uploadUrl: string,
    chunk?: { bytes: Uint8Array; start: number; total: number },
  ): Promise<GraphResponse> {
    const url = checkUploadUrl(uploadUrl);
    if (!this.gate.allowMutation) throw new Refused("upload needs --allow-mutation");
    const headers: Record<string, string> = {};
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (chunk) {
      const end = chunk.start + chunk.bytes.length - 1;
      headers["content-type"] = "application/octet-stream";
      headers["content-range"] = `bytes ${chunk.start}-${end}/${chunk.total}`;
      // A copy backed by a plain ArrayBuffer, which is what fetch's BodyInit accepts.
      body = new Uint8Array(chunk.bytes);
    }
    const started = Date.now();
    const res = await this.fetchImpl(url, { method, headers, ...(body === undefined ? {} : { body }) });
    const parsed = await readBody(res);
    this.exchanges.push(
      exchange(
        "upload",
        method,
        `${url.host}${shapePath(url.pathname + url.search)}`,
        res,
        Date.now() - started,
        parsed,
      ),
    );
    return { status: res.status, headers: res.headers, body: parsed };
  }
}

export function checkUploadUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Refused("upload URL is not https");
  if (!UPLOAD_HOSTS.has(url.host)) throw new Refused(`upload host ${url.host} is not a known Outlook host`);
  return url;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { nonJsonLength: text.length };
  }
}

function exchange(
  transport: Exchange["transport"],
  method: string,
  path: string,
  res: Response,
  ms: number,
  body: unknown,
): Exchange {
  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const v = res.headers.get(name);
    if (v != null) headers[name] = name === "location" ? shapeLocation(v) : redact(v, 120);
  }
  const out: Exchange = {
    transport,
    method,
    path: transport === "graph" ? shapePath(path) : path,
    status: res.status,
    ms,
    headers,
  };
  const err = errorOf(body);
  if (err) out.error = err;
  return out;
}

function shapeLocation(v: string): string {
  try {
    const u = new URL(v);
    return `${u.host}${shapePath(u.pathname + u.search)}`;
  } catch {
    return redact(v, 120);
  }
}

/** Graph's error envelope, redacted. The code is the evidence; the message is kept short and scrubbed. */
export function errorOf(body: unknown): { code: string; message: string } | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined;
  const e = body.error;
  if (typeof e !== "object" || e === null) return undefined;
  const { code, message } = e as { code?: unknown; message?: unknown };
  return {
    code: typeof code === "string" ? code : "unknown",
    message: typeof message === "string" ? redact(message) : "",
  };
}

/** Narrow helper for reading fields out of Graph JSON without `any`. */
export function field(body: unknown, ...keys: string[]): unknown {
  let cur: unknown = body;
  for (const k of keys) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function str(body: unknown, ...keys: string[]): string | undefined {
  const v = field(body, ...keys);
  return typeof v === "string" ? v : undefined;
}

export function list(body: unknown, key = "value"): unknown[] {
  const v = field(body, key);
  return Array.isArray(v) ? v : [];
}
