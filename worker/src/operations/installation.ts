import { GmailMcpError } from "@gmail-mcp/shared/errors";
import type { Env } from "../env";
/** Marker is installed only by the trusted schema/deployment verifier, never by a public route. */
export function installationAssertion(env: Env): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO _assert(x) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM recovery_installation WHERE singleton=1 AND schema_version=5 AND restore_generation=? AND mutation_state='active')",
  ).bind(env.RESTORE_GENERATION);
}
export async function assertInstallation(env: Env): Promise<void> {
  try {
    if (!env.RESTORE_GENERATION || !env.BUILD_ID) throw new Error("missing deployment identity");
    await installationAssertion(env).run();
  } catch {
    throw new GmailMcpError("internal", "maintenance: mutations are frozen");
  }
}
