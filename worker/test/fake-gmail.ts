import { b64url, fromB64url } from "../src/crypto/random";

export type FakeHeader = { name: string; value: string };
export type FakePart = {
  partId: string;
  mimeType: string;
  filename: string;
  headers: FakeHeader[];
  body: { size: number; data?: string; attachmentId?: string };
  parts?: FakePart[];
};
export type FakeMessage = {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  internalDate: string;
  sizeEstimate: number;
  payload: FakePart;
  raw?: string;
};
export type FakeLabel = {
  id: string;
  name: string;
  type: "system" | "user";
  labelListVisibility?: string;
  messageListVisibility?: string;
  color?: { textColor: string; backgroundColor: string };
};
export type Fault = { status: number; message?: string; reason?: string; headers?: Record<string, string> };
export type Sent = {
  raw: Uint8Array<ArrayBuffer>;
  via: "media" | "resumable" | "draft";
  threadId: string | null;
  id: string;
};

const enc = new TextEncoder();
const utf8b64url = (s: string) => b64url(new Uint8Array(enc.encode(s)));

const SYSTEM_LABELS = ["INBOX", "SENT", "DRAFT", "TRASH", "SPAM", "UNREAD", "STARRED", "IMPORTANT"];

/**
 * Enough Gmail to exercise every tool: a message store with MessagePart trees, threads derived from
 * messages, drafts, labels, attachment bytes, and both upload protocols. Shapes follow the discovery
 * document (revision 20260907). Faults are consumed in order by the next matching request.
 */
export class FakeGmail {
  readonly messages = new Map<string, FakeMessage>();
  readonly drafts = new Map<string, { id: string; message: FakeMessage }>();
  readonly labels = new Map<string, FakeLabel>();
  readonly attachments = new Map<string, Uint8Array<ArrayBuffer>>(); // key `${messageId}/${attachmentId}`
  readonly sent: Sent[] = [];
  readonly requests: Request[] = [];
  readonly faults: Fault[] = [];
  readonly rejectTokens = new Set<string>();
  rejectAll = false;
  private seq = 0;
  private sessions = new Map<string, { path: string; contentType: string; threadId: string | null }>();
  /** Applied to the first PUT after a session was opened; the fault queue cannot express "session ok, PUT fails". */
  afterSession: Fault | null = null;
  /** Runs before every request; returning a Response short-circuits (Plan 5's fault injection hook). */
  before: ((req: Request) => Promise<Response | undefined>) | null = null;

  constructor() {
    for (const id of SYSTEM_LABELS) this.labels.set(id, { id, name: id, type: "system" });
  }

  next(prefix: string): string {
    return `${prefix}${++this.seq}`;
  }

  seedMessage(o: {
    id?: string;
    threadId?: string;
    from: string;
    to: string[];
    cc?: string[];
    subject: string;
    text?: string;
    html?: string;
    messageId?: string;
    references?: string;
    replyTo?: string;
    labelIds?: string[];
    attachments?: { filename: string; mime: string; bytes: Uint8Array<ArrayBuffer>; inline?: boolean }[];
    internalDate?: number;
  }): FakeMessage {
    const id = o.id ?? this.next("m");
    const threadId = o.threadId ?? id;
    const headers: FakeHeader[] = [
      { name: "From", value: o.from },
      { name: "To", value: o.to.join(", ") },
      ...(o.cc && o.cc.length ? [{ name: "Cc", value: o.cc.join(", ") }] : []),
      { name: "Subject", value: o.subject },
      { name: "Message-ID", value: o.messageId ?? `<${id}@fake.test>` },
      ...(o.references ? [{ name: "References", value: o.references }] : []),
      ...(o.replyTo ? [{ name: "Reply-To", value: o.replyTo }] : []),
      { name: "Date", value: new Date(o.internalDate ?? Date.now()).toUTCString() },
    ];
    const textPart: FakePart = {
      partId: "0",
      mimeType: "text/plain",
      filename: "",
      headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }],
      body: { size: (o.text ?? "").length, data: utf8b64url(o.text ?? "") },
    };
    const htmlPart: FakePart | null = o.html
      ? {
          partId: "1",
          mimeType: "text/html",
          filename: "",
          headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }],
          body: { size: o.html.length, data: utf8b64url(o.html) },
        }
      : null;
    const bodyParts: FakePart[] = htmlPart
      ? [
          {
            partId: "a",
            mimeType: "multipart/alternative",
            filename: "",
            headers: [],
            body: { size: 0 },
            parts: [textPart, htmlPart],
          },
        ]
      : [textPart];
    const attParts: FakePart[] = (o.attachments ?? []).map((a, i) => {
      const attachmentId = `att${id}_${i}`;
      // Gmail parks large parts behind attachmentId and inlines small ones in data; both shapes are real.
      if (!a.inline) this.attachments.set(`${id}/${attachmentId}`, a.bytes);
      return {
        partId: String(i + 2),
        mimeType: a.mime,
        filename: a.filename,
        headers: [
          { name: "Content-Type", value: `${a.mime}; name="${a.filename}"` },
          { name: "Content-Disposition", value: `attachment; filename="${a.filename}"` },
        ],
        body: a.inline
          ? { size: a.bytes.byteLength, data: b64url(a.bytes) }
          : { size: a.bytes.byteLength, attachmentId },
      };
    });
    const payload: FakePart =
      attParts.length === 0
        ? { ...bodyParts[0]!, headers: [...headers, ...bodyParts[0]!.headers] }
        : {
            partId: "",
            mimeType: "multipart/mixed",
            filename: "",
            headers,
            body: { size: 0 },
            parts: [...bodyParts, ...attParts],
          };
    const msg: FakeMessage = {
      id,
      threadId,
      labelIds: o.labelIds ?? ["INBOX", "UNREAD"],
      snippet: (o.text ?? "").slice(0, 100),
      internalDate: String(o.internalDate ?? Date.now()),
      sizeEstimate: (o.text ?? "").length + (o.attachments ?? []).reduce((n, a) => n + a.bytes.byteLength, 0),
      payload,
    };
    this.messages.set(id, msg);
    return msg;
  }

  seedDraft(o: Parameters<FakeGmail["seedMessage"]>[0]): { id: string; message: FakeMessage } {
    const message = this.seedMessage({ ...o, labelIds: ["DRAFT"] });
    const id = this.next("r");
    const draft = { id, message };
    this.drafts.set(id, draft);
    return draft;
  }

  private view(m: FakeMessage, format: string, metadataHeaders: string[]): unknown {
    if (format === "minimal")
      return {
        id: m.id,
        threadId: m.threadId,
        labelIds: m.labelIds,
        snippet: m.snippet,
        internalDate: m.internalDate,
        sizeEstimate: m.sizeEstimate,
      };
    if (format === "raw")
      return {
        id: m.id,
        threadId: m.threadId,
        labelIds: m.labelIds,
        snippet: m.snippet,
        internalDate: m.internalDate,
        raw: m.raw ?? utf8b64url("RAW-NOT-STORED"),
      };
    if (format === "metadata") {
      const wanted = new Set(metadataHeaders.map((h) => h.toLowerCase()));
      const headers =
        wanted.size === 0 ? m.payload.headers : m.payload.headers.filter((h) => wanted.has(h.name.toLowerCase()));
      return {
        id: m.id,
        threadId: m.threadId,
        labelIds: m.labelIds,
        snippet: m.snippet,
        internalDate: m.internalDate,
        sizeEstimate: m.sizeEstimate,
        payload: { partId: "", mimeType: m.payload.mimeType, filename: "", headers, body: { size: 0 } },
      };
    }
    return m;
  }

  private error(status: number, message: string, reason?: string): Response {
    return Response.json(
      { error: { code: status, message, errors: reason ? [{ reason, message }] : [], status: reason ?? "ERROR" } },
      { status },
    );
  }

  private matches(m: FakeMessage, q: string | null, includeSpamTrash: boolean): boolean {
    if (!includeSpamTrash && (m.labelIds.includes("SPAM") || m.labelIds.includes("TRASH"))) return false;
    if (!q) return true;
    const header = (n: string) => m.payload.headers.find((h) => h.name.toLowerCase() === n)?.value ?? "";
    for (const term of q.split(/\s+/).filter(Boolean)) {
      if (term.startsWith("rfc822msgid:")) {
        if (header("message-id") !== term.slice("rfc822msgid:".length)) return false;
      } else if (term.startsWith("subject:")) {
        if (!header("subject").toLowerCase().includes(term.slice(8).toLowerCase())) return false;
      } else if (term.startsWith("label:")) {
        if (!m.labelIds.includes(term.slice(6).toUpperCase())) return false;
      } else if (term.startsWith("from:")) {
        if (!header("from").toLowerCase().includes(term.slice(5).toLowerCase())) return false;
      } else if (!(m.snippet + header("subject")).toLowerCase().includes(term.toLowerCase())) return false;
    }
    return true;
  }

  private page<T extends { id: string }>(items: T[], url: URL): { items: T[]; nextPageToken?: string } {
    const max = Number(url.searchParams.get("maxResults") ?? "100");
    const start = Number(url.searchParams.get("pageToken") ?? "0");
    const slice = items.slice(start, start + max);
    return start + max < items.length ? { items: slice, nextPageToken: String(start + max) } : { items: slice };
  }

  private storeSent(raw: Uint8Array<ArrayBuffer>, via: Sent["via"], threadIdHint: string | null): FakeMessage {
    const text = new TextDecoder().decode(raw);
    const headerBlock = text.split(/\r?\n\r?\n/)[0] ?? "";
    const header = (n: string) => {
      const re = new RegExp(`^${n}:[ \\t]*(.*(?:\\r?\\n[ \\t].*)*)`, "im");
      const m = re.exec(headerBlock);
      return m ? m[1]!.replace(/\r?\n[ \t]+/g, " ").trim() : "";
    };
    const id = this.next("m");
    const inReplyTo = header("In-Reply-To");
    const parent = [...this.messages.values()].find((m) =>
      m.payload.headers.some((h) => h.name === "Message-ID" && h.value === inReplyTo),
    );
    const threadId = threadIdHint ?? parent?.threadId ?? id;
    const msg: FakeMessage = {
      id,
      threadId,
      labelIds: ["SENT"],
      snippet: text.slice(-100),
      internalDate: String(Date.now()),
      sizeEstimate: raw.byteLength,
      payload: {
        partId: "",
        mimeType: header("Content-Type").split(";")[0] || "text/plain",
        filename: "",
        headers: ["From", "To", "Cc", "Bcc", "Subject", "Message-ID", "In-Reply-To", "References", "Date"]
          .map((n) => ({ name: n, value: header(n) }))
          .filter((h) => h.value !== ""),
        body: { size: 0 },
      },
      raw: b64url(raw),
    };
    this.messages.set(id, msg);
    this.sent.push({ raw, via, threadId, id });
    return msg;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    // A clone is stored so a test can read the body after the handler consumed the original.
    this.requests.push(req.clone());
    const early = this.before ? await this.before(req) : undefined;
    if (early) return early;
    const token = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
    if (!token.startsWith("at-") || this.rejectAll || this.rejectTokens.has(token))
      return this.error(401, "Invalid Credentials", "authError");
    const fault = this.faults.shift();
    if (fault) {
      const res = this.error(fault.status, fault.message ?? `fault ${fault.status}`, fault.reason);
      for (const [k, v] of Object.entries(fault.headers ?? {})) res.headers.set(k, v);
      return res;
    }
    const url = new URL(req.url);
    const p = url.pathname;
    const raw = async () => new Uint8Array(await req.arrayBuffer());

    // Uploads.
    if (p.startsWith("/upload/gmail/v1/users/me/")) {
      const rest = p.slice("/upload/gmail/v1/users/me/".length);
      const ct = req.headers.get("content-type") ?? "";
      const bytes = await raw();
      if (ct.startsWith("multipart/related")) {
        const boundary = /boundary=([^;]+)/.exec(ct)![1]!;
        // latin1 keeps byte offsets equal to character offsets, which the media slice below relies on.
        const all = new TextDecoder("latin1").decode(bytes);
        const parts = all.split(`--${boundary}`).slice(1, -1);
        const meta = JSON.parse(parts[0]!.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim()) as {
          threadId?: string;
        };
        const mediaStart = all.indexOf(parts[1]!) + parts[1]!.indexOf("\r\n\r\n") + 4;
        const mediaEnd = all.lastIndexOf(`\r\n--${boundary}--`);
        return this.upload(rest, req.method, bytes.subarray(mediaStart, mediaEnd), "media", meta.threadId ?? null);
      }
      return this.upload(rest, req.method, bytes, "media", null);
    }
    if (p.startsWith("/resumable/upload/gmail/v1/users/me/")) {
      const rest = p.slice("/resumable/upload/gmail/v1/users/me/".length);
      if (req.method === "PUT" && url.searchParams.get("upload_id")) {
        const s = this.sessions.get(url.searchParams.get("upload_id")!);
        if (!s) return this.error(404, "unknown upload session");
        this.sessions.delete(url.searchParams.get("upload_id")!);
        if (this.afterSession) {
          const f = this.afterSession;
          return this.error(f.status, f.message ?? `fault ${f.status}`, f.reason);
        }
        return this.upload(s.path, "POST", await raw(), "resumable", s.threadId);
      }
      const meta = (await req.json().catch(() => ({}))) as { threadId?: string };
      const uploadId = this.next("u");
      this.sessions.set(uploadId, {
        path: rest,
        contentType: req.headers.get("x-upload-content-type") ?? "",
        threadId: meta.threadId ?? null,
      });
      return new Response(null, {
        status: 200,
        headers: {
          location: `https://gmail.googleapis.com/resumable/upload/gmail/v1/users/me/${rest}?uploadType=resumable&upload_id=${uploadId}`,
        },
      });
    }
    if (!p.startsWith("/gmail/v1/users/me/")) return this.error(404, `unknown path ${p}`);
    const rest = p.slice("/gmail/v1/users/me/".length);
    const seg = rest.split("/");
    const json = async () => (await req.json().catch(() => ({}))) as Record<string, unknown>;

    if (seg[0] === "labels") {
      if (req.method === "GET" && seg.length === 1) return Response.json({ labels: [...this.labels.values()] });
      if (req.method === "POST" && seg.length === 1) {
        const body = await json();
        if (typeof body.name !== "string" || body.name === "") return this.error(400, "Invalid label name");
        if ([...this.labels.values()].some((l) => l.name === body.name))
          return this.error(409, "Label name exists or conflicts");
        const label: FakeLabel = { id: this.next("Label_"), name: body.name, type: "user", ...(body as object) };
        this.labels.set(label.id, label);
        return Response.json(label);
      }
      const label = this.labels.get(seg[1] ?? "");
      if (!label) return this.error(404, "Requested entity was not found.", "notFound");
      if (req.method === "GET") return Response.json(label);
      if (label.type === "system") return this.error(400, "Invalid request: system label");
      if (req.method === "PUT" || req.method === "PATCH") {
        const updated = { ...label, ...(await json()), id: label.id, type: "user" as const };
        this.labels.set(label.id, updated);
        return Response.json(updated);
      }
      if (req.method === "DELETE") {
        this.labels.delete(label.id);
        return new Response(null, { status: 204 });
      }
    }

    if (seg[0] === "messages") {
      if (req.method === "GET" && seg.length === 1) {
        const all = [...this.messages.values()].filter(
          (m) =>
            !m.labelIds.includes("DRAFT") &&
            this.matches(m, url.searchParams.get("q"), url.searchParams.get("includeSpamTrash") === "true"),
        );
        const { items, nextPageToken } = this.page(all, url);
        return Response.json({
          messages: items.map((m) => ({ id: m.id, threadId: m.threadId })),
          resultSizeEstimate: all.length,
          ...(nextPageToken ? { nextPageToken } : {}),
        });
      }
      if (req.method === "POST" && seg[1] === "send" && seg.length === 2) {
        const body = await json();
        if (typeof body.raw !== "string") return this.error(400, "raw required");
        return Response.json(
          this.publicMessage(
            this.storeSent(fromB64url(body.raw), "media", typeof body.threadId === "string" ? body.threadId : null),
          ),
        );
      }
      const m = this.messages.get(seg[1] ?? "");
      if (!m || m.labelIds.includes("DRAFT")) return this.error(404, "Requested entity was not found.", "notFound");
      if (req.method === "GET" && seg.length === 2)
        return Response.json(
          this.view(m, url.searchParams.get("format") ?? "full", url.searchParams.getAll("metadataHeaders")),
        );
      if (req.method === "GET" && seg[2] === "attachments") {
        const bytes = this.attachments.get(`${m.id}/${seg[3]}`);
        if (!bytes) return this.error(404, "Requested entity was not found.", "notFound");
        return Response.json({ attachmentId: seg[3], size: bytes.byteLength, data: b64url(bytes) });
      }
      if (req.method === "POST" && seg[2] === "modify") {
        const body = await json();
        this.applyModify(m, body);
        return Response.json(this.publicMessage(m));
      }
      if (req.method === "POST" && seg[2] === "trash") {
        this.applyModify(m, { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] });
        return Response.json(this.publicMessage(m));
      }
      if (req.method === "POST" && seg[2] === "untrash") {
        this.applyModify(m, { addLabelIds: ["INBOX"], removeLabelIds: ["TRASH"] });
        return Response.json(this.publicMessage(m));
      }
      if (req.method === "DELETE") return this.error(403, "permanent delete must never be called", "forbidden");
    }

    if (seg[0] === "threads") {
      const threads = () => {
        const byThread = new Map<string, FakeMessage[]>();
        for (const m of this.messages.values())
          if (!m.labelIds.includes("DRAFT")) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
        return byThread;
      };
      if (req.method === "GET" && seg.length === 1) {
        const q = url.searchParams.get("q");
        const incl = url.searchParams.get("includeSpamTrash") === "true";
        const all = [...threads().entries()]
          .filter(([, ms]) => ms.some((m) => this.matches(m, q, incl)))
          .map(([id, ms]) => ({ id, snippet: ms[ms.length - 1]!.snippet, historyId: "1" }));
        const { items, nextPageToken } = this.page(all, url);
        return Response.json({
          threads: items,
          resultSizeEstimate: all.length,
          ...(nextPageToken ? { nextPageToken } : {}),
        });
      }
      const ms = threads().get(seg[1] ?? "");
      if (!ms) return this.error(404, "Requested entity was not found.", "notFound");
      if (req.method === "GET" && seg.length === 2)
        return Response.json({
          id: seg[1],
          historyId: "1",
          messages: ms.map((m) =>
            this.view(m, url.searchParams.get("format") ?? "full", url.searchParams.getAll("metadataHeaders")),
          ),
        });
      if (req.method === "POST" && seg[2] === "modify") {
        const body = await json();
        for (const m of ms) this.applyModify(m, body);
        return Response.json({ id: seg[1], messages: ms.map((m) => this.publicMessage(m)) });
      }
      if (req.method === "POST" && seg[2] === "trash") {
        for (const m of ms) this.applyModify(m, { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] });
        return Response.json({ id: seg[1], messages: ms.map((m) => this.publicMessage(m)) });
      }
      if (req.method === "POST" && seg[2] === "untrash") {
        for (const m of ms) this.applyModify(m, { addLabelIds: ["INBOX"], removeLabelIds: ["TRASH"] });
        return Response.json({ id: seg[1], messages: ms.map((m) => this.publicMessage(m)) });
      }
      if (req.method === "DELETE") return this.error(403, "permanent delete must never be called", "forbidden");
    }

    if (seg[0] === "drafts") {
      if (req.method === "GET" && seg.length === 1) {
        const all = [...this.drafts.values()].filter((d) => this.matches(d.message, url.searchParams.get("q"), true));
        const { items, nextPageToken } = this.page(all, url);
        return Response.json({
          drafts: items.map((d) => ({ id: d.id, message: { id: d.message.id, threadId: d.message.threadId } })),
          resultSizeEstimate: all.length,
          ...(nextPageToken ? { nextPageToken } : {}),
        });
      }
      if (req.method === "POST" && seg[1] === "send") {
        const body = await json();
        const d = this.drafts.get(String(body.id));
        if (!d) return this.error(404, "Requested entity was not found.", "notFound");
        this.drafts.delete(d.id);
        this.messages.delete(d.message.id);
        const rawBytes = d.message.raw
          ? fromB64url(d.message.raw)
          : new Uint8Array(
              enc.encode(
                `Subject: ${d.message.payload.headers.find((h) => h.name === "Subject")?.value ?? ""}\r\n\r\n`,
              ),
            );
        const sent = this.storeSent(rawBytes, "draft", d.message.threadId);
        return Response.json(this.publicMessage(sent));
      }
      if (req.method === "POST" && seg.length === 1) {
        const body = (await json()) as { message?: { raw?: string; threadId?: string } };
        if (typeof body.message?.raw !== "string") return this.error(400, "message.raw required");
        return Response.json(this.createDraftFromRaw(fromB64url(body.message.raw), body.message.threadId ?? null));
      }
      const d = this.drafts.get(seg[1] ?? "");
      if (!d) return this.error(404, "Requested entity was not found.", "notFound");
      if (req.method === "GET")
        return Response.json({
          id: d.id,
          message: this.view(
            d.message,
            url.searchParams.get("format") ?? "full",
            url.searchParams.getAll("metadataHeaders"),
          ),
        });
      if (req.method === "PUT") {
        const body = (await json()) as { message?: { raw?: string; threadId?: string } };
        if (typeof body.message?.raw !== "string") return this.error(400, "message.raw required");
        this.messages.delete(d.message.id);
        this.drafts.delete(d.id);
        const created = this.createDraftFromRaw(
          fromB64url(body.message.raw),
          body.message.threadId ?? d.message.threadId,
          d.id,
        );
        return Response.json(created);
      }
      if (req.method === "DELETE") return this.error(403, "drafts.delete must never be called", "forbidden");
    }
    return this.error(404, `unhandled ${req.method} ${p}`);
  };

  private upload(
    path: string,
    method: string,
    bytes: Uint8Array<ArrayBuffer>,
    via: "media" | "resumable",
    threadId: string | null = null,
  ): Response {
    if (path === "messages/send" && method === "POST")
      return Response.json(this.publicMessage(this.storeSent(bytes, via, threadId)));
    if (path === "drafts" && method === "POST") return Response.json(this.createDraftFromRaw(bytes, threadId));
    const m = /^drafts\/([^/]+)$/.exec(path);
    if (m && method === "PUT") {
      const d = this.drafts.get(m[1]!);
      if (!d) return this.error(404, "Requested entity was not found.", "notFound");
      this.messages.delete(d.message.id);
      this.drafts.delete(d.id);
      return Response.json(this.createDraftFromRaw(bytes, threadId ?? d.message.threadId, d.id));
    }
    return this.error(404, `unhandled upload ${method} ${path}`);
  }

  private createDraftFromRaw(bytes: Uint8Array<ArrayBuffer>, threadId: string | null, keepId?: string) {
    const msg = this.storeSent(bytes, "draft", threadId);
    this.sent.pop(); // a draft is stored, not sent
    msg.labelIds = ["DRAFT"];
    const id = keepId ?? this.next("r");
    this.drafts.set(id, { id, message: msg });
    return { id, message: { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds } };
  }

  private applyModify(m: FakeMessage, body: Record<string, unknown>): void {
    const add = Array.isArray(body.addLabelIds) ? (body.addLabelIds as string[]) : [];
    const remove = Array.isArray(body.removeLabelIds) ? (body.removeLabelIds as string[]) : [];
    const set = new Set(m.labelIds);
    for (const r of remove) set.delete(r);
    for (const a of add) set.add(a);
    m.labelIds = [...set];
  }

  private publicMessage(m: FakeMessage) {
    return { id: m.id, threadId: m.threadId, labelIds: m.labelIds };
  }
}
