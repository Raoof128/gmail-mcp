import { env } from "cloudflare:test";
import { it, expect, vi } from "vitest";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { registerCompanionClient, COMPANION_KEY, COMPANION_MARKER } from "../src/auth/companion";
import { allowedScopeForClient } from "../src/auth/scopes";
it("reconciles an interrupted creation and never recreates based on an empty listing", async () => {
  let client: any;
  let visible = false;
  // eslint-disable-next-line @typescript-eslint/require-await -- This test double implements an async interface.
  const create = vi.fn(async (metadata: any) => {
    client = { ...metadata, clientId: "interrupted-client" };
    throw new Error("lost creation response");
  });
  const helpers = {
    createClient: create,
    // eslint-disable-next-line @typescript-eslint/require-await -- This test double implements an async interface.
    listClients: async () => ({ items: visible ? [client] : [] }),
  } as unknown as OAuthHelpers;
  await expect(registerCompanionClient(env, helpers)).rejects.toThrow();
  const old = await env.DB.prepare("SELECT value FROM settings WHERE key=?")
    .bind(COMPANION_KEY)
    .first<{ value: string }>();
  const attempt = JSON.parse(old!.value);
  attempt.lease_until = 0;
  await env.DB.prepare("UPDATE settings SET value=? WHERE key=?").bind(JSON.stringify(attempt), COMPANION_KEY).run();
  await expect(registerCompanionClient(env, helpers)).rejects.toThrow(/quarantined/);
  expect(create).toHaveBeenCalledOnce();
  const next = JSON.parse(
    (await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(COMPANION_KEY).first<{ value: string }>())!
      .value,
  );
  next.lease_until = 0;
  await env.DB.prepare("UPDATE settings SET value=? WHERE key=?").bind(JSON.stringify(next), COMPANION_KEY).run();
  visible = true;
  expect(await registerCompanionClient(env, helpers)).toBe("interrupted-client");
  expect(create).toHaveBeenCalledOnce();
});
it("does not classify an unfinalized marked client as MCP", async () => {
  expect(await allowedScopeForClient(env.DB, "orphan", COMPANION_MARKER + "attempt")).toBeNull();
});
