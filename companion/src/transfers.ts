import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { UploadMetadata, STAGING_LIMITS } from "@gmail-mcp/shared/staging";
import { AccountAlias, MediaType } from "@gmail-mcp/shared/schemas";
import { Authority, boundedBody } from "./http.ts";
import type { NativePort } from "./protocol.ts";
const relative = z
  .string()
  .min(1)
  .max(1024)
  .transform((s) => s.normalize("NFC"))
  .refine(
    (s) =>
      !/[\\\p{Cc}\p{Cf}]/u.test(s) &&
      s.split("/").length <= 16 &&
      s
        .split("/")
        .every(
          (p) => p !== "" && p !== "." && p !== ".." && !p.startsWith(".gmail-mcp-") && Buffer.byteLength(p) <= 255,
        ),
  );
const root = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const StageInput = z.strictObject({
  account: AccountAlias,
  root,
  path: relative,
  mime: MediaType,
  idempotency_key: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
    .optional(),
});
export const SaveInput = z.strictObject({ handle: z.string().regex(/^sh_[A-Za-z0-9_-]{43}$/), root, path: relative });
const resultSchema = z.object({
  transfer_id: z.string(),
  account: z.string(),
  account_id: z.string(),
  intent_hash: z.string(),
  state: z.string(),
  generation: z.number().optional(),
  ticket_id: z.string().optional(),
  pending_id: z.string().optional(),
  approval_url: z.string().optional(),
  handle: z.string().optional(),
  handle_expires_at: z.number().optional(),
  error: z.string().optional(),
});
const recordSchema = z.object({
  input: z.object({ transfer_id: z.string(), account: z.string(), metadata: UploadMetadata }),
  result: resultSchema.optional(),
  retry: z.object({ expected_generation: z.number(), retry_request_id: z.string() }).optional(),
});
const snapshotSchema = z.object({
  state: z.literal("ready"),
  file: z.object({ size: z.number(), sha256: z.string() }),
});
const receiptSchema = z.object({
  state: z.string(),
  root: z.string(),
  relative: z.string(),
  file: z.object({ size: z.number(), sha256: z.string() }).optional(),
});
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = (prefix: string) => prefix + "_" + randomBytes(32).toString("base64url");
export class Companion {
  private readonly scope: string;
  private readonly native: NativePort;
  private readonly api: Authority;
  private readonly token: string;
  constructor(native: NativePort, api: Authority, token: string, owner: { user_id: string; client_id: string }) {
    this.native = native;
    this.api = api;
    this.token = token;
    this.scope = hash([api.origin, owner.client_id, owner.user_id]);
  }
  async stage(raw: unknown): Promise<Record<string, unknown>> {
    const source = StageInput.parse(raw);
    const requestHash = hash([this.scope, source.account, source.root, source.path, source.mime]);
    const key = source.idempotency_key ? "explicit:" + source.idempotency_key : "automatic:" + requestHash;
    const context = { scope: this.scope, key, requestHash };
    const known = z
      .object({ requestHash: z.string().optional(), payload: z.string().optional() })
      .parse((await this.native.call({ op: "journal.get", ...context })).meta);
    if (known.requestHash && known.requestHash !== requestHash) throw new Error("idempotency_conflict");
    let record: z.infer<typeof recordSchema>;
    if (known.payload) record = recordSchema.parse(JSON.parse(known.payload));
    else {
      const transfer_id = id("tr");
      const snapshot = snapshotSchema.parse(
        (await this.native.call({ op: "snapshot.prepare", ...context, ...source, transfer_id })).meta,
      );
      // The durable source snapshot is authoritative even when the live path changes later.
      record = {
        input: {
          transfer_id,
          account: source.account,
          metadata: UploadMetadata.parse({
            filename: source.path.split("/").at(-1),
            mime: source.mime,
            ...snapshot.file,
          }),
        },
      };
    }
    const persist = () => this.native.call({ op: "journal.put", ...context, payload: JSON.stringify(record) });
    await persist();
    const publicResult = () => {
      const result = record.result!;
      const { ticket_id: _ticket, ...safe } = result;
      if (safe.handle && safe.handle_expires_at !== undefined && safe.handle_expires_at <= Date.now())
        safe.state = "completed_handle_expired";
      return { ...safe, snapshot_sha256: record.input.metadata.sha256, root: source.root, path: source.path };
    };
    if (record.result?.handle || ["failed", "denied", "completed_handle_expired"].includes(record.result?.state ?? ""))
      return publicResult();
    await this.native.call({ op: "snapshot.check", ...context });
    const intent = async (mode: "ensure" | "retry") =>
      resultSchema.parse(
        await this.api.json("/staging/intent", this.token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...record.input, mode, ...(mode === "retry" ? record.retry : {}) }),
        }),
      );
    let result = await intent(record.retry ? "retry" : "ensure");
    if (!record.retry && known.payload && ["expired", "abandoned"].includes(result.state) && result.generation) {
      record.retry = { expected_generation: result.generation, retry_request_id: id("rr") };
      await persist();
      result = await intent("retry");
    }
    record.result = result;
    delete record.retry;
    await persist();
    if (result.ticket_id) {
      const bytes = (await this.native.call({ op: "snapshot.read", ...context })).body;
      const response = await this.api.request(
        "/staging/" + result.ticket_id,
        this.token,
        {
          method: "PUT",
          headers: { "content-length": String(record.input.metadata.size), "content-type": record.input.metadata.mime },
          body: bytes,
        },
        STAGING_LIMITS.bodyMs,
      );
      const data = await boundedBody(response, 65536);
      if (!response.ok) throw new Error(`authority_${response.status}`);
      record.result = resultSchema.parse(JSON.parse(new TextDecoder().decode(data)));
      await persist();
    }
    if (record.result?.handle) {
      await this.native.call({ op: "snapshot.release", ...context }).catch(() => {});
    }
    return publicResult();
  }
  async save(raw: unknown): Promise<Record<string, unknown>> {
    const source = SaveInput.parse(raw),
      context = { scope: this.scope, ...source };
    let receipt = receiptSchema.parse((await this.native.call({ op: "save.prepare", ...context })).meta);
    if (receipt.state === "prepared") {
      const response = await this.api.request("/staging/" + source.handle, this.token, {}, STAGING_LIMITS.bodyMs);
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`authority_${response.status}`);
      }
      const length = response.headers.get("content-length"),
        digest = response.headers.get("x-sha256");
      if (
        !length ||
        !/^(0|[1-9][0-9]*)$/.test(length) ||
        Number(length) > STAGING_LIMITS.fileBytes ||
        !digest ||
        !/^[a-f0-9]{64}$/.test(digest)
      ) {
        await response.body?.cancel();
        throw new Error("download_metadata");
      }
      const bytes = await boundedBody(response, Number(length));
      if (bytes.length !== Number(length) || createHash("sha256").update(bytes).digest("hex") !== digest)
        throw new Error("download_integrity");
      receipt = receiptSchema.parse(
        (await this.native.call({ op: "save.publish", ...context, sha256: digest }, bytes)).meta,
      );
    }
    if (receipt.state === "published") {
      try {
        z.object({ acknowledged: z.literal(true), replayed: z.boolean() }).parse(
          await this.api.json("/staging/" + source.handle + "/ack", this.token, { method: "POST" }),
        );
        receipt = receiptSchema.parse((await this.native.call({ op: "save.ack", ...context })).meta);
      } catch {
        return { state: "published", acknowledged: false, root: source.root, path: source.path, ...receipt.file };
      }
    }
    if (receipt.state !== "acknowledged") throw new Error("publication_unknown");
    return { state: "published", acknowledged: true, root: source.root, path: source.path, ...receipt.file };
  }
}
