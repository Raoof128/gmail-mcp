import { describe, expect, it } from "vitest";
import { checkRoute, checkUploadUrl, GraphClient, Refused, type Gate, type Method } from "../graph.ts";
import { fakeFetch, on } from "./fake.ts";

const ALL: Gate = { allowMutation: true, allowDestructive: true };
const NONE: Gate = { allowMutation: false, allowDestructive: false };
const MUT: Gate = { allowMutation: true, allowDestructive: false };
const CREATED = new Set(["AAMkDraft="]);

const refused = (method: Method, path: string, gate: Gate = ALL) =>
  expect(() => checkRoute(method, path, gate, CREATED)).toThrow(Refused);
const allowed = (method: Method, path: string, gate: Gate) =>
  expect(() => checkRoute(method, path, gate, CREATED)).not.toThrow();

describe("checkRoute", () => {
  it("never sends permanentDelete, under any prefix or spelling", () => {
    for (const path of [
      "/v1.0/me/messages/AAMkDraft=/permanentDelete",
      "/v1.0/me/messages/AAMkDraft=/PERMANENTDELETE",
      "/v1.0/me/messages/AAMkDraft=/%70ermanentDelete",
      "/v1.0/me/mailFolders/x/permanentDelete",
      "/v1.0/users/u/messages/x/permanentDelete",
    ]) {
      refused("POST", path);
    }
  });

  it("sends only /v1.0/me paths", () => {
    refused("GET", "/v1.0/users/someone/messages");
    refused("GET", "/beta/me/messages");
    refused("GET", "/v1.0/meanwhile/messages");
    refused("GET", "/v1.0/me/../users/x/messages");
    refused("GET", "/v1.0/me/messages%2F..%2F..%2Fusers");
    allowed("GET", "/v1.0/me", NONE);
    allowed("GET", "/v1.0/me/messages", NONE);
  });

  it("never sends a batch", () => {
    refused("POST", "/v1.0/me/$batch");
    refused("POST", "/v1.0/$batch");
  });

  it("needs --allow-mutation for POST and PATCH", () => {
    refused("POST", "/v1.0/me/messages", NONE);
    refused("PATCH", "/v1.0/me/messages/x", NONE);
    allowed("POST", "/v1.0/me/messages", MUT);
  });

  it("allows DELETE on a message only when destructive and created by this run", () => {
    refused("DELETE", "/v1.0/me/messages/AAMkDraft=", MUT);
    refused("DELETE", "/v1.0/me/messages/AAMkSomeoneElse=", ALL);
    allowed("DELETE", "/v1.0/me/messages/AAMkDraft=", ALL);
  });

  it("allows cleanup DELETEs on definitions, never on folders or attachments", () => {
    allowed("DELETE", "/v1.0/me/outlook/masterCategories/c1", MUT);
    allowed("DELETE", "/v1.0/me/mailFolders/inbox/messageRules/r1", MUT);
    refused("DELETE", "/v1.0/me/mailFolders/AAMkFolder=");
    refused("DELETE", "/v1.0/me/messages/AAMkDraft=/attachments/a1");
    refused("DELETE", "/v1.0/me/inferenceClassification/overrides/o1");
  });
});

describe("GraphClient", () => {
  it("adds the bearer token and the immutable-id preference, and keeps the token out of evidence", async () => {
    const { fetch, seen } = fakeFetch([on("GET", "/v1.0/me/messages", { status: 200, body: { value: [] } })]);
    const g = new GraphClient(() => Promise.resolve("secret-token-value"), NONE, fetch);
    await g.call("GET", "/v1.0/me/messages?$top=1", { prefer: ['outlook.body-content-type="text"'] });
    expect(seen[0]?.headers.authorization).toBe("Bearer secret-token-value");
    expect(seen[0]?.headers.prefer).toBe('IdType="ImmutableId", outlook.body-content-type="text"');
    expect(JSON.stringify(g.exchanges)).not.toContain("secret-token-value");
  });

  it("refuses unsafe HTML and hosts other than Graph", async () => {
    const { fetch, seen } = fakeFetch([]);
    const g = new GraphClient(() => Promise.resolve("t"), ALL, fetch);
    await expect(g.call("GET", "/v1.0/me/messages", { prefer: ["outlook.allow-unsafe-html"] })).rejects.toThrow(
      Refused,
    );
    await expect(g.call("GET", "https://evil.example/v1.0/me/messages")).rejects.toThrow(Refused);
    expect(seen).toHaveLength(0);
  });

  it("records shapes and error codes, not values", async () => {
    const { fetch } = fakeFetch([
      on("GET", "/v1.0/me/messages", {
        status: 400,
        body: {
          error: { code: "SearchWithFilter", message: "for owner@example.com in AAMkAGVmMDEzMTM4LTZmYWUtNDdk=" },
        },
      }),
    ]);
    const g = new GraphClient(() => Promise.resolve("t"), NONE, fetch);
    await g.call(
      "GET",
      "/v1.0/me/messages?$search=%22secret%20words%22&$filter=" + encodeURIComponent("subject eq 'private'"),
    );
    const ex = JSON.stringify(g.exchanges);
    expect(ex).toContain("SearchWithFilter");
    expect(ex).not.toContain("owner@example.com");
    expect(ex).not.toContain("secret words");
    expect(ex).not.toContain("private");
  });
});

describe("upload transport", () => {
  const url =
    "https://outlook.office.com/api/v2.0/Users('u')/Messages('m')/AttachmentSessions('s')?authtoken=eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9abcdef";

  it("never sends the Graph token, and keeps the URL's credential out of evidence", async () => {
    const { fetch, seen } = fakeFetch([() => ({ status: 200, body: { nextExpectedRanges: ["4-"] } })]);
    const g = new GraphClient(() => Promise.resolve("graph-token"), MUT, fetch);
    await g.upload("PUT", url, { bytes: new Uint8Array(4), start: 0, total: 8 });
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(seen[0]?.headers["content-range"]).toBe("bytes 0-3/8");
    expect(JSON.stringify(g.exchanges)).not.toContain("eyJ0eXAi");
  });

  it("refuses plain http, unknown hosts, and runs without --allow-mutation", async () => {
    expect(() => checkUploadUrl("http://outlook.office.com/x")).toThrow(Refused);
    expect(() => checkUploadUrl("https://attacker.example/x")).toThrow(Refused);
    const g = new GraphClient(() => Promise.resolve("t"), NONE, fakeFetch([]).fetch);
    await expect(g.upload("DELETE", url)).rejects.toThrow(Refused);
  });
});
