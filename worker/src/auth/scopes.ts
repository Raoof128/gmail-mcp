import type { Env } from "../env";
import { getCompanionClientId, isCompanionName } from "./companion";

export const SCOPES = ["mcp", "staging"] as const;
export type Scope = (typeof SCOPES)[number];

export function audienceFor(env: Env, scope: Scope): string {
  return `https://${env.WORKER_HOSTNAME}/${scope}`;
}

/** Spec 4.1: the companion may hold staging; everyone else may hold mcp. The library does not do this for us. */
export async function allowedScopeForClient(
  db: D1Database,
  clientId: string,
  clientName?: string,
): Promise<Scope | null> {
  const companion = await getCompanionClientId(db);
  return companion !== null && clientId === companion ? "staging" : isCompanionName(clientName) ? null : "mcp";
}

export function resolveGrantedScope(requested: string[], allowed: Scope): Scope | null {
  const set = new Set(requested.filter((s) => s !== ""));
  if (set.size === 0) return allowed;
  if (set.size === 1 && set.has(allowed)) return allowed;
  return null;
}
