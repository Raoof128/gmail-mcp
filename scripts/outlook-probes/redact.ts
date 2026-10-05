import { createHash } from "node:crypto";

/** The fixed tenant id of personal Microsoft accounts. Public, so it is kept as evidence. */
export const CONSUMER_TID = "9188040d-6c67-4c5b-b112-36a304b66dad";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Ids, tokens, delta links and upload credentials all look like long base64 runs.
const OPAQUE = /[A-Za-z0-9_\-+/=.%]{24,}/g;

/**
 * Removes anything that could identify the mailbox or carry a credential: addresses, GUIDs other than
 * the public consumer tenant, and long opaque runs. Evidence keeps shapes and outcomes, never values.
 */
export function redact(text: string, max = 300): string {
  const out = text
    .replace(EMAIL, "<email>")
    .replace(GUID, (g) => (g.toLowerCase() === CONSUMER_TID ? g : "<guid>"))
    .replace(OPAQUE, (m) => (m.toLowerCase() === CONSUMER_TID ? m : `<opaque:${m.length}>`));
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** A short, stable stand-in for an id, so two observations can be compared without recording either. */
export function hashId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

const ID_SEGMENT = /^[A-Za-z0-9_\-+=%]{20,}$/;

/**
 * Turns a request path into a template: id-like segments become `{id}`, and string literals inside
 * OData expressions become `'…'`. Query parameter names survive, because which parameter a call used is
 * the evidence; their literal values do not.
 */
export function shapePath(pathAndQuery: string): string {
  const [path = "", query] = pathAndQuery.split("?", 2);
  const shapedPath = path
    .split("/")
    .map((seg) => {
      const decoded = safeDecode(seg);
      if (ID_SEGMENT.test(decoded)) return "{id}";
      // OData function syntax such as messages('id') or AttachmentSessions('id').
      return decoded.replace(/\('([^']*)'\)/g, "('{id}')");
    })
    .join("/");
  if (query == null) return shapedPath;
  const params = new URLSearchParams(query);
  const shaped: string[] = [];
  for (const [name, value] of params) {
    if (name === "$deltatoken" || name === "$skiptoken" || name === "authtoken") {
      shaped.push(`${name}=<opaque>`);
    } else if (name.startsWith("$")) {
      shaped.push(`${name}=${redact(value.replace(/'[^']*'/g, "'…'").replace(/"[^"]*"/g, '"…"'), 200)}`);
    } else {
      shaped.push(`${name}=<value>`);
    }
  }
  return `${shapedPath}?${shaped.join("&")}`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export interface Charset {
  count: number;
  maxLength: number;
  minLength: number;
  classes: string[];
  others: string[];
}

/** Which character classes a set of ids uses. Feeds P12: the REST id alphabet is undocumented. */
export function idCharset(ids: readonly string[]): Charset {
  const classes = new Set<string>();
  const others = new Set<string>();
  let maxLength = 0;
  let minLength = ids.length === 0 ? 0 : Number.POSITIVE_INFINITY;
  for (const id of ids) {
    maxLength = Math.max(maxLength, id.length);
    minLength = Math.min(minLength, id.length);
    for (const ch of id) {
      if (/[A-Z]/.test(ch)) classes.add("A-Z");
      else if (/[a-z]/.test(ch)) classes.add("a-z");
      else if (/[0-9]/.test(ch)) classes.add("0-9");
      else if ("-_+/=".includes(ch)) classes.add(ch);
      else others.add(ch.codePointAt(0)?.toString(16) ?? "?");
    }
  }
  return { count: ids.length, maxLength, minLength, classes: [...classes].sort(), others: [...others].sort() };
}
