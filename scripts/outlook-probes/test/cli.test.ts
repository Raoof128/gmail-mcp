import { describe, expect, it } from "vitest";
import type { TokenSet } from "../auth.ts";
import { blockedBy, execute, parseConfig, UsageError, type Config, type Deps } from "../cli.ts";
import type { RunRecord } from "../evidence.ts";
import { fakeFetch, on, type Route } from "./fake.ts";

const OWNER = "owner@example.com";
const TOKENS: TokenSet = {
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  expiresIn: 3600,
  scope: "Mail.ReadWrite",
};

function config(over: Partial<Config> = {}): Config {
  return {
    auth: { authority: "consumers", clientId: "c", port: 8400 },
    probes: [],
    out: "unused",
    allowMutation: false,
    allowDestructive: false,
    allowLoad: false,
    allowExternalForward: false,
    pollIntervalMs: 1,
    pollLimitMs: 50,
    ...over,
  };
}

async function run(cfg: Config, routes: Route[]) {
  const { fetch, seen } = fakeFetch([on("GET", "/v1.0/me", { status: 200, body: { mail: OWNER } }), ...routes]);
  let written: RunRecord | undefined;
  const lines: string[] = [];
  const deps: Deps = {
    fetch,
    login: () => Promise.resolve(TOKENS),
    print: (l) => lines.push(l),
    sleep: () => Promise.resolve(),
    write: (r) => {
      written = r;
      return "memory";
    },
    evidenceKind: "synthetic",
  };
  const result = await execute(cfg, deps);
  return { result, seen, written, lines };
}

describe("parseConfig", () => {
  it("defaults to every probe and refuses unknown ids and bad ports", () => {
    const c = parseConfig(["--authority", "consumers", "--client-id", "x"]);
    expect(c.probes).toContain("P1");
    expect(c.allowMutation).toBe(false);
    expect(() => parseConfig(["--authority", "consumers", "--client-id", "x", "--probes", "P99"])).toThrow(UsageError);
    expect(() => parseConfig(["--authority", "consumers", "--client-id", "x", "--port", "80"])).toThrow(UsageError);
    expect(() => parseConfig(["--authority", "common", "--client-id", "x"])).toThrow();
    expect(() => parseConfig([])).toThrow(UsageError);
  });
});

describe("blockedBy", () => {
  it("opens each kind only with its own flags", () => {
    const base = config();
    expect(blockedBy("read", base)).toBeNull();
    expect(blockedBy("token", base)).toBeNull();
    expect(blockedBy("mutation", base)).not.toBeNull();
    expect(blockedBy("destructive", config({ allowDestructive: true }))).not.toBeNull();
    expect(blockedBy("destructive", config({ allowMutation: true, allowDestructive: true }))).toBeNull();
    expect(blockedBy("load", base)).not.toBeNull();
    expect(blockedBy("external", config({ allowMutation: true, allowExternalForward: true }))).toBe(
      "needs --forward-target",
    );
  });
});

describe("execute", () => {
  it("skips gated and manual probes, runs read probes, and sends nothing but GET", async () => {
    const { result, seen, written } = await run(config({ probes: ["P1", "P4", "P7", "P5"] }), [
      on("GET", "/v1.0/me/messages", (req) =>
        req.url.searchParams.has("$search") && req.url.searchParams.has("$filter")
          ? { status: 400, body: { error: { code: "SearchWithFilter", message: "not supported" } } }
          : { status: 200, body: { value: [{ conversationId: "AAQkConversationIdThatIsLong=" }] } },
      ),
    ]);
    const byId = Object.fromEntries(result.probes.map((p) => [p.id, p]));
    expect(byId.P1?.outcome).toBe("skipped");
    expect(byId.P4?.outcome).toBe("skipped");
    expect(byId.P7?.reason).toContain("runbook");
    expect(byId.P5?.outcome).toBe("observed");
    expect(byId.P5?.facts.searchWithFilter).toEqual({ status: 400, code: "SearchWithFilter", count: 0 });
    expect(seen.every((r) => r.method === "GET")).toBe(true);
    expect(written?.evidenceKind).toBe("synthetic");
    const text = JSON.stringify(written);
    expect(text).not.toContain(OWNER);
    expect(text).not.toContain("access-secret");
    expect(text).not.toContain("refresh-secret");
  });

  it("refuses to mutate unless --confirm-mailbox names the signed-in mailbox", async () => {
    await expect(run(config({ allowMutation: true, probes: ["P1"] }), [])).rejects.toThrow(UsageError);
    const { seen } = await run(config({ allowMutation: true, confirmMailbox: "OWNER@example.com", probes: [] }), []);
    expect(seen.map((r) => r.method)).toEqual(["GET"]);
    await expect(
      run(config({ allowMutation: true, confirmMailbox: "someone@else.test", probes: ["P1"] }), []),
    ).rejects.toThrow(UsageError);
  });

  it("observes a send by the draft id and by the stamped Message-ID", async () => {
    const draft = { id: "AAMkDraftIdThatIsLongEnough=", internetMessageId: "", sent: false };
    const routes: Route[] = [
      on("GET", "/v1.0/me/mailFolders/sentitems", { status: 200, body: { id: "SENT" } }),
      on("GET", "/v1.0/me/mailFolders/inbox", { status: 200, body: { id: "INBOX" } }),
      on("POST", "/v1.0/me/messages", { status: 201, body: { id: draft.id } }),
      on("PATCH", `/v1.0/me/messages/${draft.id}`, (req) => {
        draft.internetMessageId = (JSON.parse(req.body ?? "{}") as { internetMessageId: string }).internetMessageId;
        return { status: 200, body: {} };
      }),
      on("POST", `/v1.0/me/messages/${draft.id}/send`, () => {
        draft.sent = true;
        return { status: 202 };
      }),
      on("GET", `/v1.0/me/messages/${draft.id}`, () => ({
        status: 200,
        body: {
          id: draft.id,
          isDraft: !draft.sent,
          parentFolderId: draft.sent ? "SENT" : "DRAFTS",
          internetMessageId: draft.internetMessageId,
        },
      })),
      on("GET", /^\/v1\.0\/me\/(mailFolders\/(SENT|INBOX)\/)?messages$/, {
        status: 200,
        body: { value: [{ id: draft.id }] },
      }),
    ];
    const { result, seen } = await run(config({ allowMutation: true, confirmMailbox: OWNER, probes: ["P1"] }), routes);
    const p1 = result.probes[0];
    expect(p1?.outcome).toBe("observed");
    expect(p1?.facts).toMatchObject({
      stampAcceptedOnDraft: true,
      send: { status: 202, code: null },
      draftIdResolvesToSentCopy: true,
      draftIdSameIdReturned: true,
      stampSurvivedInSentCopy: true,
      P2_stampSeenByRecipient: true,
      P3_filter_sentItems: { status: 200, code: null, matches: 1 },
    });
    // Every Graph request carried the immutable-id preference; the only recipient was the account itself.
    expect(
      seen
        .filter((r) => r.url.host === "graph.microsoft.com")
        .every((r) => r.headers.prefer?.startsWith('IdType="ImmutableId"')),
    ).toBe(true);
    const create = seen.find((r) => r.method === "POST" && r.url.pathname === "/v1.0/me/messages");
    expect(create?.body).toContain(OWNER);
    expect(JSON.stringify(result)).not.toContain(OWNER);
  });

  it("records category outcomes, including a rename the service rejects", async () => {
    const { result } = await run(config({ allowMutation: true, confirmMailbox: OWNER, probes: ["P13"] }), [
      on("POST", "/v1.0/me/outlook/masterCategories", { status: 201, body: { id: "cat1" } }),
      on("POST", "/v1.0/me/messages", { status: 201, body: { id: "AAMkDraftIdThatIsLongEnough=" } }),
      on("PATCH", /^\/v1\.0\/me\/messages\//, { status: 200, body: { "@odata.etag": 'W/"1"' } }),
      on("PATCH", /^\/v1\.0\/me\/outlook\/masterCategories\//, {
        status: 400,
        body: { error: { code: "ErrorInvalidRequest", message: "x" } },
      }),
      on("DELETE", /^\/v1\.0\/me\/outlook\/masterCategories\//, { status: 204 }),
      on("GET", /^\/v1\.0\/me\/messages\//, { status: 200, body: { categories: [] } }),
    ]);
    expect(result.probes[0]?.outcome).toBe("observed");
    expect(result.probes[0]?.facts).toMatchObject({
      renameCategory: { status: 400, code: "ErrorInvalidRequest" },
      P18_itemStillCarriesName: false,
    });
  });
});
