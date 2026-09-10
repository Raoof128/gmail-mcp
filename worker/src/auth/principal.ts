import type { Env } from "../env";
import { audienceFor, type Scope } from "./scopes";

export type Principal = { userId: string; email: string; scope: Scope };

function challenge(env: Env, scope: Scope, error?: string): string {
  const parts = [
    `Bearer realm="OAuth"`,
    `resource_metadata="https://${env.WORKER_HOSTNAME}/.well-known/oauth-protected-resource/${scope}"`,
  ];
  if (error) parts.push(`error="${error}"`, `scope="${scope}"`);
  return parts.join(", ");
}

/**
 * The provider has already checked signature, expiry and audience before this runs. This is the part
 * it leaves to the application: the token's scope must cover the route, and the props must belong to
 * the token's owner. user_id comes from here and nowhere else (spec 3.1).
 */
export async function requireScope(request: Request, env: Env, scope: Scope): Promise<Principal | Response> {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  const token = m ? await env.OAUTH_PROVIDER.unwrapToken<{ sub?: string; email?: string }>(m[1]!) : null;
  if (!token)
    return new Response(null, { status: 401, headers: { "www-authenticate": challenge(env, scope, "invalid_token") } });
  if (!token.scope.includes(scope)) {
    return new Response(null, {
      status: 403,
      headers: { "www-authenticate": challenge(env, scope, "insufficient_scope") },
    });
  }
  const aud = Array.isArray(token.audience) ? token.audience : token.audience ? [token.audience] : [];
  if (!aud.includes(audienceFor(env, scope))) {
    return new Response(null, { status: 401, headers: { "www-authenticate": challenge(env, scope, "invalid_token") } });
  }
  const props = token.grant.props;
  if (typeof props?.sub !== "string" || props.sub !== token.userId || typeof props.email !== "string") {
    return new Response(null, { status: 401, headers: { "www-authenticate": challenge(env, scope, "invalid_token") } });
  }
  return { userId: props.sub, email: props.email, scope };
}
