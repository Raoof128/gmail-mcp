import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Modifier } from "@gmail-mcp/shared/actions";

export type ParsedAddress = { local: string; domain: string; normalized: string };
export type TrustContext = { selfAddresses: string[]; allowlist: string[]; orgDomains: string[] };
export const MAX_RECIPIENTS = 500;
export const BULK_THRESHOLD = 10;

/**
 * Deliberately restricted grammar: no quoted local parts, no comments, no leading, trailing or
 * consecutive dots, one address per string. This is a permission boundary, so it prefers false
 * negatives. Plan 3 may swap in a full RFC 5322 parser for message construction.
 */
const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^[A-Za-z0-9¡-￿-]+(?:\.[A-Za-z0-9¡-￿-]+)+$/u;

function fail(raw: string): never {
  throw new GmailMcpError("invalid_address", `invalid_address: ${raw.slice(0, 64)}`);
}

export function toAsciiDomain(domain: string): string {
  if (!DOMAIN.test(domain)) fail(domain);
  try {
    const host = new URL(`http://${domain}/`).hostname;
    if (!host || host.includes("..")) fail(domain);
    return host.toLowerCase();
  } catch {
    fail(domain);
  }
}

export function parseAddress(raw: string): ParsedAddress {
  if (/[\r\n\0]/.test(raw) || raw.includes(",") || raw.includes('"')) fail(raw);
  let spec = raw.trim();
  const m = spec.match(/^[^<>]*<([^<>]+)>$/);
  if (m) spec = m[1]!.trim();
  else if (/[<>]/.test(spec)) fail(raw);
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1 || spec.indexOf("@") !== at) fail(raw);
  const localRaw = spec.slice(0, at);
  const domainRaw = spec.slice(at + 1);
  if (!LOCAL.test(localRaw)) fail(raw);
  const domain = toAsciiDomain(domainRaw);
  // SMTP treats local parts as potentially case sensitive. Only normalise where the provider
  // is known to fold case and strip +tags.
  const isGmail = domain === "gmail.com" || domain === "googlemail.com";
  const local = isGmail ? localRaw.split("+")[0]!.toLowerCase() : localRaw;
  if (local.length === 0) fail(raw);
  return { local, domain, normalized: `${local}@${domain}` };
}

export function isTrusted(addr: ParsedAddress, ctx: TrustContext): boolean {
  const norm = (s: string) => parseAddress(s).normalized;
  if (ctx.selfAddresses.some((s) => norm(s) === addr.normalized)) return true;
  for (const p of ctx.allowlist) {
    if (p.startsWith("@")) {
      if (toAsciiDomain(p.slice(1)) === addr.domain) return true;
    } else if (norm(p) === addr.normalized) return true;
  }
  return ctx.orgDomains.some((d) => toAsciiDomain(d) === addr.domain);
}

export function recipientModifiers(all: string[], ctx: TrustContext): Modifier[] {
  if (all.length > MAX_RECIPIENTS) {
    throw new GmailMcpError("limit_exceeded", `limit_exceeded: recipients ${all.length} > ${MAX_RECIPIENTS}`);
  }
  const parsed = all.map(parseAddress);
  const distinct = new Set(parsed.map((p) => p.normalized));
  const mods: Modifier[] = [];
  if (parsed.some((p) => !isTrusted(p, ctx))) mods.push("+external");
  if (distinct.size > BULK_THRESHOLD) mods.push("+bulk");
  return mods;
}
