import { randomBytes } from "node:crypto";
import type { TokenSet } from "./auth.ts";
import { idTokenShape } from "./auth.ts";
import type { Recorder } from "./evidence.ts";
import { errorOf, field, list, str, type GraphClient, type GraphResponse } from "./graph.ts";
import { hashId, idCharset } from "./redact.ts";

/**
 * What a probe needs before it may run. `read` touches nothing; `token` only refreshes; `load` sends a
 * burst of reads; `mutation` creates drafts, sends to the account itself, or edits settings it then
 * restores; `destructive` issues a DELETE on an item the run created; `external` sends mail outside the
 * mailbox through a forwarding rule, to a target the owner names.
 */
export type Kind = "read" | "token" | "load" | "mutation" | "destructive" | "external";

export interface ProbeOptions {
  forwardTarget?: string;
  pollIntervalMs: number;
  pollLimitMs: number;
}

export interface ProbeContext {
  graph: GraphClient;
  rec: Recorder;
  runTag: string;
  /** The account's own address. Used as the only recipient of probe mail and never recorded. */
  self: string;
  opts: ProbeOptions;
  sleep: (ms: number) => Promise<void>;
  /** Present when the run holds a refresh token. */
  refresh?: () => Promise<TokenSet>;
  firstTokens?: TokenSet;
}

export interface Probe {
  id: string;
  title: string;
  kind: Kind;
  run: (ctx: ProbeContext) => Promise<void>;
}

export class ProbeFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeFailed";
  }
}

const ME = "/v1.0/me";

/** Builds a query with literal `$` parameter names, which is how the Graph documentation writes them. */
export function q(path: string, params: Record<string, string>): string {
  const parts = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return parts.length === 0 ? path : `${path}?${parts.join("&")}`;
}

function expect(res: GraphResponse, ok: number[], what: string): void {
  if (!ok.includes(res.status)) {
    const e = errorOf(res.body);
    throw new ProbeFailed(`${what} returned ${res.status}${e ? ` ${e.code}` : ""}`);
  }
}

function outcome(res: GraphResponse): { status: number; code: string | null } {
  return { status: res.status, code: errorOf(res.body)?.code ?? null };
}

function subject(ctx: ProbeContext, label: string): string {
  return `[probe ${ctx.runTag}] ${label}`;
}

async function wellKnown(ctx: ProbeContext, name: string): Promise<string> {
  const res = await ctx.graph.call("GET", q(`${ME}/mailFolders/${name}`, { $select: "id" }));
  expect(res, [200], `folder ${name}`);
  const id = str(res.body, "id");
  if (id == null) throw new ProbeFailed(`folder ${name} has no id`);
  return id;
}

async function selfDraft(ctx: ProbeContext, label: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await ctx.graph.call("POST", `${ME}/messages`, {
    body: {
      subject: subject(ctx, label),
      body: { contentType: "Text", content: "Outlook provider probe. Safe to delete." },
      toRecipients: [{ emailAddress: { address: ctx.self } }],
      ...extra,
    },
  });
  expect(res, [201], "create draft");
  const id = str(res.body, "id");
  if (id == null) throw new ProbeFailed("draft has no id");
  ctx.graph.created.add(id);
  return id;
}

/** Polls until `done` returns a value or the limit passes. Returns the value and the elapsed time. */
async function poll<T>(ctx: ProbeContext, attempt: () => Promise<T | undefined>): Promise<{ value?: T; ms: number }> {
  const started = Date.now();
  for (;;) {
    const value = await attempt();
    const ms = Date.now() - started;
    if (value !== undefined) return { value, ms };
    if (ms >= ctx.opts.pollLimitMs) return { ms };
    await ctx.sleep(ctx.opts.pollIntervalMs);
  }
}

function stamp(ctx: ProbeContext): string {
  return `<probe-${ctx.runTag}-${randomBytes(6).toString("hex")}@outlook-probes.invalid>`;
}

const filterEq = (prop: string, value: string) => `${prop} eq '${value.replace(/'/g, "''")}'`;

// P1, P2, P3: does anything identify a sent message, and which key survives?
const sendObservation: Probe = {
  id: "P1",
  title: "Draft id and stamped Message-ID across send (also records P2 and P3)",
  kind: "mutation",
  async run(ctx) {
    const sentId = await wellKnown(ctx, "sentitems");
    const inboxId = await wellKnown(ctx, "inbox");
    const draftId = await selfDraft(ctx, "send observation");
    const mid = stamp(ctx);

    const patch = await ctx.graph.call("PATCH", `${ME}/messages/${encodeURIComponent(draftId)}`, {
      body: { internetMessageId: mid },
    });
    ctx.rec.set("stampPatch", outcome(patch));
    const reread = await ctx.graph.call(
      "GET",
      q(`${ME}/messages/${encodeURIComponent(draftId)}`, { $select: "internetMessageId,isDraft" }),
    );
    ctx.rec.set("stampAcceptedOnDraft", str(reread.body, "internetMessageId") === mid);

    const send = await ctx.graph.call("POST", `${ME}/messages/${encodeURIComponent(draftId)}/send`);
    ctx.rec.set("send", outcome(send));
    expect(send, [202], "send");

    const seen = await poll(ctx, async () => {
      const r = await ctx.graph.call(
        "GET",
        q(`${ME}/messages/${encodeURIComponent(draftId)}`, { $select: "id,isDraft,parentFolderId,internetMessageId" }),
      );
      ctx.rec.push("draftIdAfterSend", {
        status: r.status,
        isDraft: field(r.body, "isDraft") === true,
        inSentItems: str(r.body, "parentFolderId") === sentId,
      });
      if (r.status === 200 && field(r.body, "isDraft") === false) return r;
      return undefined;
    });
    ctx.rec.set("draftIdResolvesToSentCopy", seen.value != null && str(seen.value.body, "parentFolderId") === sentId);
    ctx.rec.set("draftIdSameIdReturned", seen.value != null && str(seen.value.body, "id") === draftId);
    ctx.rec.set("draftIdObservationMs", seen.ms);
    if (seen.value) ctx.rec.set("stampSurvivedInSentCopy", str(seen.value.body, "internetMessageId") === mid);

    // P3: the filter the Worker would fall back to, on Sent Items and on the whole mailbox.
    for (const [label, path] of [
      ["sentItems", `${ME}/mailFolders/${encodeURIComponent(sentId)}/messages`],
      ["allMessages", `${ME}/messages`],
    ] as const) {
      const r = await ctx.graph.call("GET", q(path, { $filter: filterEq("internetMessageId", mid), $select: "id" }));
      ctx.rec.set(`P3_filter_${label}`, { ...outcome(r), matches: list(r.body).length });
    }

    // P2: the copy the recipient (this same mailbox) received.
    const received = await poll(ctx, async () => {
      const r = await ctx.graph.call(
        "GET",
        q(`${ME}/mailFolders/${encodeURIComponent(inboxId)}/messages`, {
          $filter: filterEq("internetMessageId", mid),
          $select: "id",
        }),
      );
      return list(r.body).length > 0 ? list(r.body).length : undefined;
    });
    ctx.rec.set("P2_stampSeenByRecipient", received.value != null);
    ctx.rec.set("P2_recipientMatches", received.value ?? 0);
    ctx.rec.set("P2_recipientObservationMs", received.ms);
  },
};

// P3 on its own: read-only, against the newest message in Sent Items.
const filterProbe: Probe = {
  id: "P3",
  title: "$filter on internetMessageId, read-only, against the newest sent message",
  kind: "read",
  async run(ctx) {
    const newest = await ctx.graph.call(
      "GET",
      q(`${ME}/mailFolders/sentitems/messages`, { $top: "1", $select: "internetMessageId" }),
    );
    expect(newest, [200], "newest sent");
    const mid = str(list(newest.body)[0], "internetMessageId");
    if (mid == null) {
      ctx.rec.set("note", "Sent Items is empty");
      return;
    }
    for (const [label, path] of [
      ["sentItems", `${ME}/mailFolders/sentitems/messages`],
      ["allMessages", `${ME}/messages`],
    ] as const) {
      const r = await ctx.graph.call("GET", q(path, { $filter: filterEq("internetMessageId", mid), $select: "id" }));
      ctx.rec.set(`filter_${label}`, { ...outcome(r), matches: list(r.body).length });
    }
  },
};

// P4: what DELETE does. The answer decides whether DELETE can ever be offered; until then it is refused.
const deleteProbe: Probe = {
  id: "P4",
  title: "DELETE on a probe draft, then on its Deleted Items copy",
  kind: "destructive",
  async run(ctx) {
    const draftId = await selfDraft(ctx, "delete semantics");
    const mid = stamp(ctx);
    await ctx.graph.call("PATCH", `${ME}/messages/${encodeURIComponent(draftId)}`, {
      body: { internetMessageId: mid },
    });
    const del = await ctx.graph.call("DELETE", `${ME}/messages/${encodeURIComponent(draftId)}`);
    ctx.rec.set("firstDelete", outcome(del));
    const after = await ctx.graph.call(
      "GET",
      q(`${ME}/messages/${encodeURIComponent(draftId)}`, { $select: "parentFolderId" }),
    );
    ctx.rec.set("getAfterFirstDelete", outcome(after));
    const deletedItems = await wellKnown(ctx, "deleteditems");
    ctx.rec.set("afterFirstDeleteInDeletedItems", str(after.body, "parentFolderId") === deletedItems);
    for (const folder of ["deleteditems", "recoverableitemsdeletions"]) {
      const r = await ctx.graph.call(
        "GET",
        q(`${ME}/mailFolders/${folder}/messages`, { $filter: filterEq("internetMessageId", mid), $select: "id" }),
      );
      ctx.rec.set(`foundIn_${folder}`, { ...outcome(r), matches: list(r.body).length });
    }
    if (after.status === 200) {
      const second = await ctx.graph.call("DELETE", `${ME}/messages/${encodeURIComponent(draftId)}`);
      ctx.rec.set("secondDelete", outcome(second));
      const r = await ctx.graph.call(
        "GET",
        q(`${ME}/mailFolders/recoverableitemsdeletions/messages`, {
          $filter: filterEq("internetMessageId", mid),
          $select: "id",
        }),
      );
      ctx.rec.set("afterSecondDeleteInRecoverable", { ...outcome(r), matches: list(r.body).length });
    }
  },
};

// P5: which query combinations the service accepts.
const queryProbe: Probe = {
  id: "P5",
  title: "$search, $filter and $orderby combinations, including conversationId",
  kind: "read",
  async run(ctx) {
    const newest = await ctx.graph.call("GET", q(`${ME}/messages`, { $top: "1", $select: "conversationId" }));
    expect(newest, [200], "newest message");
    const cid = str(list(newest.body)[0], "conversationId");
    const cases: Record<string, Record<string, string>> = {
      searchOnly: { $search: '"the"', $top: "5", $select: "id" },
      searchWithFilter: { $search: '"the"', $filter: "isRead eq false", $top: "5", $select: "id" },
      searchWithOrderby: { $search: '"the"', $orderby: "receivedDateTime desc", $top: "5", $select: "id" },
    };
    if (cid != null) {
      cases.conversationFilterOnly = { $filter: filterEq("conversationId", cid), $select: "id" };
      cases.conversationFilterOrderbyDate = {
        $filter: filterEq("conversationId", cid),
        $orderby: "receivedDateTime asc",
        $select: "id",
      };
      cases.dateFirstThenConversation = {
        $filter: `receivedDateTime ge 1900-01-01T00:00:00Z and ${filterEq("conversationId", cid)}`,
        $orderby: "receivedDateTime asc",
        $select: "id",
      };
    }
    for (const [name, params] of Object.entries(cases)) {
      const r = await ctx.graph.call("GET", q(`${ME}/messages`, params));
      ctx.rec.set(name, { ...outcome(r), count: list(r.body).length });
    }
  },
};

// P6: refresh-token rotation and the id token's claim shape.
const tokenProbe: Probe = {
  id: "P6",
  title: "Refresh-token rotation and id-token claim shape",
  kind: "token",
  async run(ctx) {
    ctx.rec.set("idToken", idTokenShape(ctx.firstTokens?.idToken));
    ctx.rec.set("grantedScope", ctx.firstTokens?.scope ?? "");
    if (ctx.refresh == null || ctx.firstTokens?.refreshToken == null) {
      ctx.rec.set("note", "no refresh token was issued");
      return;
    }
    const first = ctx.firstTokens.refreshToken;
    const next = await ctx.refresh();
    ctx.rec.set("refreshReturnedNewToken", next.refreshToken != null);
    ctx.rec.set("refreshTokenRotated", next.refreshToken != null && hashId(next.refreshToken) !== hashId(first));
    ctx.rec.set("accessExpiresIn", next.expiresIn);
  },
};

const MiB = 1024 * 1024;

async function uploadSession(ctx: ProbeContext, draftId: string, size: number): Promise<GraphResponse> {
  return ctx.graph.call("POST", `${ME}/messages/${encodeURIComponent(draftId)}/attachments/createUploadSession`, {
    body: { AttachmentItem: { attachmentType: "file", name: "probe.bin", size } },
  });
}

function shapeOfUploadUrl(raw: string): Record<string, string | string[]> {
  const u = new URL(raw);
  return {
    host: u.host,
    pathSegments: u.pathname.split("/").map((s) => (s.length > 20 ? "{id}" : s.replace(/\('([^']*)'\)/g, "('{id}')"))),
    queryNames: [...new URLSearchParams(u.search).keys()],
  };
}

// P8: the upload session, learned rather than assumed.
const uploadProbe: Probe = {
  id: "P8",
  title: "Upload-session URL shape, expiry, chunk order, resume and cancel",
  kind: "mutation",
  async run(ctx) {
    const draftId = await selfDraft(ctx, "upload session");
    const size = Math.floor(3.5 * MiB);
    const session = await uploadSession(ctx, draftId, size);
    expect(session, [201], "createUploadSession");
    const url = str(session.body, "uploadUrl");
    const exp = str(session.body, "expirationDateTime");
    if (url == null) throw new ProbeFailed("no uploadUrl");
    ctx.rec.set("uploadUrlShape", shapeOfUploadUrl(url));
    if (exp != null) ctx.rec.set("expiresInMinutes", Math.round((Date.parse(exp) - Date.now()) / 60_000));
    ctx.rec.set("nextExpectedRanges", (field(session.body, "nextExpectedRanges") as string[] | undefined) ?? []);

    const bytes = new Uint8Array(randomBytes(size));
    const split = 2 * MiB;
    const first = await ctx.graph.upload("PUT", url, { bytes: bytes.subarray(0, split), start: 0, total: size });
    ctx.rec.set("chunk1", {
      status: first.status,
      nextExpectedRanges: (field(first.body, "nextExpectedRanges") as string[] | undefined) ?? [],
    });
    const last = await ctx.graph.upload("PUT", url, { bytes: bytes.subarray(split), start: split, total: size });
    ctx.rec.set("chunk2", { status: last.status, locationReturned: last.headers.get("location") != null });

    // Out of order: send the second chunk first on a new session.
    const second = await uploadSession(ctx, draftId, size);
    expect(second, [201], "second createUploadSession");
    const url2 = str(second.body, "uploadUrl");
    if (url2 == null) throw new ProbeFailed("no second uploadUrl");
    const outOfOrder = await ctx.graph.upload("PUT", url2, { bytes: bytes.subarray(split), start: split, total: size });
    ctx.rec.set("outOfOrderChunk", { status: outOfOrder.status, code: errorOf(outOfOrder.body)?.code ?? null });
    const cancel = await ctx.graph.upload("DELETE", url2);
    ctx.rec.set("cancel", { status: cancel.status });
    // Not performed: a chunk carrying the Graph token. The documentation forbids it and nothing depends on it.
  },
};

// P9: size boundaries for direct attachments and sessions.
const sizeProbe: Probe = {
  id: "P9",
  title: "Direct-attachment and upload-session size boundaries",
  kind: "mutation",
  async run(ctx) {
    for (const size of [2_900_000, 3_100_000, 3 * MiB + 1024]) {
      const draftId = await selfDraft(ctx, `direct attachment ${size}`);
      const r = await ctx.graph.call("POST", `${ME}/messages/${encodeURIComponent(draftId)}/attachments`, {
        body: {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: "probe.bin",
          contentBytes: Buffer.from(randomBytes(size)).toString("base64"),
        },
      });
      ctx.rec.set(`direct_${size}`, outcome(r));
    }
    for (const size of [2_900_000, 3_100_000]) {
      const draftId = await selfDraft(ctx, `session ${size}`);
      ctx.rec.set(`session_${size}`, outcome(await uploadSession(ctx, draftId, size)));
    }
  },
};

// P10: the per-mailbox concurrency cap.
const concurrencyProbe: Probe = {
  id: "P10",
  title: "Concurrent reads against the four-request mailbox cap",
  kind: "load",
  async run(ctx) {
    for (const n of [4, 8, 16]) {
      const results = await Promise.all(
        Array.from({ length: n }, () => ctx.graph.call("GET", q(`${ME}/mailFolders/inbox`, { $select: "id" }))),
      );
      const statuses: Record<string, number> = {};
      const retryAfter: string[] = [];
      for (const r of results) {
        statuses[String(r.status)] = (statuses[String(r.status)] ?? 0) + 1;
        const ra = r.headers.get("retry-after");
        if (ra != null) retryAfter.push(ra);
      }
      ctx.rec.set(`burst_${n}`, { statuses, retryAfter });
      await ctx.sleep(5_000);
    }
  },
};

// P11: body format and attachment kinds, read-only.
const bodyProbe: Probe = {
  id: "P11",
  title: "Plain-text body preference and attachment kinds",
  kind: "read",
  async run(ctx) {
    const recent = await ctx.graph.call("GET", q(`${ME}/messages`, { $top: "25", $select: "id,hasAttachments" }));
    expect(recent, [200], "recent messages");
    const first = list(recent.body)[0];
    const firstId = str(first, "id");
    if (firstId != null) {
      const r = await ctx.graph.call("GET", q(`${ME}/messages/${encodeURIComponent(firstId)}`, { $select: "body" }), {
        prefer: ['outlook.body-content-type="text"'],
      });
      ctx.rec.set("preferenceApplied", r.headers.get("preference-applied") ?? "");
      ctx.rec.set("bodyContentType", str(r.body, "body", "contentType") ?? "");
    }
    const kinds: Record<string, number> = {};
    let referenceValue: { status: number } | null = null;
    let itemValueType: string | null = null;
    for (const m of list(recent.body)
      .filter((x) => field(x, "hasAttachments") === true)
      .slice(0, 10)) {
      const id = str(m, "id");
      if (id == null) continue;
      const atts = await ctx.graph.call(
        "GET",
        q(`${ME}/messages/${encodeURIComponent(id)}/attachments`, { $select: "id,isInline,size" }),
      );
      for (const a of list(atts.body)) {
        const kind = str(a, "@odata.type") ?? "unknown";
        kinds[kind] = (kinds[kind] ?? 0) + 1;
        const aid = str(a, "id");
        if (aid == null) continue;
        if (kind.endsWith("referenceAttachment") && referenceValue == null) {
          const v = await ctx.graph.call(
            "GET",
            `${ME}/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(aid)}/$value`,
          );
          referenceValue = { status: v.status };
        }
        if (kind.endsWith("itemAttachment") && itemValueType == null) {
          const v = await ctx.graph.call(
            "GET",
            `${ME}/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(aid)}/$value`,
          );
          itemValueType = v.headers.get("content-type") ?? "";
        }
      }
    }
    ctx.rec.set("attachmentKinds", kinds);
    ctx.rec.set("referenceAttachmentValue", referenceValue);
    ctx.rec.set("itemAttachmentValueType", itemValueType);
  },
};

// P12: the id alphabet, and id stability across moves with the immutable header.
const idProbe: Probe = {
  id: "P12",
  title: "Id character set, and id stability across moves",
  kind: "read",
  async run(ctx) {
    const msgs = await ctx.graph.call("GET", q(`${ME}/messages`, { $top: "100", $select: "id,hasAttachments" }));
    const folders = await ctx.graph.call(
      "GET",
      q(`${ME}/mailFolders`, { $top: "100", includeHiddenFolders: "true", $select: "id" }),
    );
    const messageIds = list(msgs.body)
      .map((m) => str(m, "id"))
      .filter((x): x is string => x != null);
    const folderIds = list(folders.body)
      .map((m) => str(m, "id"))
      .filter((x): x is string => x != null);
    const attachmentIds: string[] = [];
    for (const m of list(msgs.body)
      .filter((x) => field(x, "hasAttachments") === true)
      .slice(0, 10)) {
      const id = str(m, "id");
      if (id == null) continue;
      const atts = await ctx.graph.call(
        "GET",
        q(`${ME}/messages/${encodeURIComponent(id)}/attachments`, { $select: "id" }),
      );
      for (const a of list(atts.body)) {
        const aid = str(a, "id");
        if (aid != null) attachmentIds.push(aid);
      }
    }
    ctx.rec.set("messageIds", { ...idCharset(messageIds) });
    ctx.rec.set("folderIds", { ...idCharset(folderIds) });
    ctx.rec.set("attachmentIds", { ...idCharset(attachmentIds) });
  },
};

const idMoveProbe: Probe = {
  id: "P12m",
  title: "Id stability across moves to Deleted Items and Junk and back",
  kind: "mutation",
  async run(ctx) {
    const draftId = await selfDraft(ctx, "id stability");
    let current = draftId;
    for (const dest of ["deleteditems", "junkemail", "drafts", "deleteditems"]) {
      const r = await ctx.graph.call("POST", `${ME}/messages/${encodeURIComponent(current)}/move`, {
        body: { destinationId: dest },
      });
      const newId = str(r.body, "id");
      ctx.rec.push("moves", { to: dest, ...outcome(r), sameId: newId === draftId });
      if (newId != null) {
        ctx.graph.created.add(newId);
        current = newId;
      }
    }
  },
};

// P13 and P18: category semantics, If-Match, and what deleting a definition does to tagged items.
const categoryProbe: Probe = {
  id: "P13",
  title: "Category names, If-Match on category writes, rename, and delete (also records P18)",
  kind: "mutation",
  async run(ctx) {
    const name = `probe ${ctx.runTag} ✓ & spaces`;
    const created = await ctx.graph.call("POST", `${ME}/outlook/masterCategories`, {
      body: { displayName: name, color: "preset3" },
    });
    ctx.rec.set("createCategory", outcome(created));
    const long = await ctx.graph.call("POST", `${ME}/outlook/masterCategories`, {
      body: { displayName: `probe ${ctx.runTag} ${"x".repeat(240)}`, color: "none" },
    });
    ctx.rec.set("createLongCategory", { ...outcome(long), length: 255 });
    const longId = str(long.body, "id");
    const catId = str(created.body, "id");

    const draftId = await selfDraft(ctx, "categories");
    const tag = await ctx.graph.call("PATCH", `${ME}/messages/${encodeURIComponent(draftId)}`, {
      body: { categories: [name] },
    });
    ctx.rec.set("applyCategory", outcome(tag));
    const etag = str(tag.body, "@odata.etag");
    const stale = await ctx.graph.call("PATCH", `${ME}/messages/${encodeURIComponent(draftId)}`, {
      body: { categories: [] },
      headers: { "if-match": 'W/"stale-probe-etag"' },
    });
    ctx.rec.set("ifMatchStale", outcome(stale));
    if (etag != null) {
      const fresh = await ctx.graph.call("PATCH", `${ME}/messages/${encodeURIComponent(draftId)}`, {
        body: { categories: [name] },
        headers: { "if-match": etag },
      });
      ctx.rec.set("ifMatchCurrent", outcome(fresh));
    }
    if (catId != null) {
      const rename = await ctx.graph.call("PATCH", `${ME}/outlook/masterCategories/${encodeURIComponent(catId)}`, {
        body: { displayName: `${name} renamed` },
      });
      ctx.rec.set("renameCategory", outcome(rename));
      const del = await ctx.graph.call("DELETE", `${ME}/outlook/masterCategories/${encodeURIComponent(catId)}`);
      ctx.rec.set("P18_deleteCategory", outcome(del));
      const after = await ctx.graph.call(
        "GET",
        q(`${ME}/messages/${encodeURIComponent(draftId)}`, { $select: "categories" }),
      );
      const cats = field(after.body, "categories");
      ctx.rec.set("P18_itemStillCarriesName", Array.isArray(cats) && cats.includes(name));
    }
    if (longId != null) await ctx.graph.call("DELETE", `${ME}/outlook/masterCategories/${encodeURIComponent(longId)}`);
  },
};

// P15: what an external forwarding rule does. Needs a target the owner controls.
const forwardRuleProbe: Probe = {
  id: "P15",
  title: "External forwarding rule: delivered, blocked with an NDR, or silent",
  kind: "external",
  async run(ctx) {
    const target = ctx.opts.forwardTarget;
    if (target == null) throw new ProbeFailed("--forward-target is required");
    const started = new Date().toISOString();
    const rule = await ctx.graph.call("POST", `${ME}/mailFolders/inbox/messageRules`, {
      body: {
        displayName: `probe ${ctx.runTag}`,
        sequence: 1,
        isEnabled: true,
        conditions: { subjectContains: [ctx.runTag] },
        actions: { forwardTo: [{ emailAddress: { address: target } }], stopProcessingRules: false },
      },
    });
    ctx.rec.set("createRule", outcome(rule));
    expect(rule, [201], "create rule");
    const ruleId = str(rule.body, "id");
    try {
      const draftId = await selfDraft(ctx, "forwarding rule trigger");
      expect(await ctx.graph.call("POST", `${ME}/messages/${encodeURIComponent(draftId)}/send`), [202], "send trigger");
      const ndr = await poll(ctx, async () => {
        const r = await ctx.graph.call(
          "GET",
          q(`${ME}/mailFolders/inbox/messages`, {
            $filter: `receivedDateTime ge ${started}`,
            $select: "subject,bodyPreview",
            $top: "50",
          }),
        );
        const hit = list(r.body).find((m) => /undeliverable|delivery has failed/i.test(str(m, "subject") ?? ""));
        return hit == null ? undefined : hit;
      });
      ctx.rec.set("ndrSeen", ndr.value != null);
      ctx.rec.set("ndrMentions5_7_520", ndr.value != null && (str(ndr.value, "bodyPreview") ?? "").includes("5.7.520"));
      ctx.rec.set("waitedMs", ndr.ms);
      ctx.rec.set("ownerMustCheckTarget", "Record by hand whether the forward arrived at the target mailbox");
    } finally {
      if (ruleId != null) {
        const del = await ctx.graph.call(
          "DELETE",
          `${ME}/mailFolders/inbox/messageRules/${encodeURIComponent(ruleId)}`,
        );
        ctx.rec.set("deleteRule", outcome(del));
      }
    }
  },
};

// P16: delta links and their failure modes.
const deltaProbe: Probe = {
  id: "P16",
  title: "Inbox delta: paging, @removed, re-use and a tampered token",
  kind: "read",
  async run(ctx) {
    let next: string | undefined = q(`${ME}/mailFolders/inbox/messages/delta`, { $select: "id" });
    let pages = 0;
    let items = 0;
    let removed = 0;
    let deltaLink: string | undefined;
    while (next != null && pages < 20) {
      const r: GraphResponse = await ctx.graph.call("GET", next, { prefer: ["odata.maxpagesize=50"] });
      expect(r, [200], "delta page");
      pages += 1;
      for (const v of list(r.body)) {
        items += 1;
        if (field(v, "@removed") != null) removed += 1;
      }
      next = str(r.body, "@odata.nextLink");
      deltaLink = str(r.body, "@odata.deltaLink") ?? deltaLink;
    }
    ctx.rec.set("initialSync", {
      pages,
      items,
      removed,
      reachedDeltaLink: deltaLink != null,
      cappedAt20Pages: next != null,
    });
    if (deltaLink == null) return;
    const again = await ctx.graph.call("GET", deltaLink);
    ctx.rec.set("reuseDeltaLink", { ...outcome(again), items: list(again.body).length });
    const u = new URL(deltaLink);
    const token = u.searchParams.get("$deltatoken");
    if (token != null) {
      u.searchParams.set("$deltatoken", `${token.slice(0, -4)}AAAA`);
      const bad = await ctx.graph.call("GET", u.toString());
      ctx.rec.set("tamperedDeltaToken", outcome(bad));
    }
  },
};

export const PROBES: readonly Probe[] = [
  sendObservation,
  filterProbe,
  deleteProbe,
  queryProbe,
  tokenProbe,
  uploadProbe,
  sizeProbe,
  concurrencyProbe,
  bodyProbe,
  idProbe,
  idMoveProbe,
  categoryProbe,
  forwardRuleProbe,
  deltaProbe,
];

/** Probes the harness cannot run, and where the runbook covers them by hand. */
export const MANUAL_PROBES: Readonly<Record<string, string>> = {
  P7: "Consent in a default tenant and for the personal registration: runbook step 4",
  P14: "Expired certificate and blocked credential types need the confidential client: runbook step 6",
  P17: "Subscriptions need a deployed HTTPS endpoint: runbook step 7",
};
