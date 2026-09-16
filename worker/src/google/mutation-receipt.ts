import { GmailMcpError } from "@gmail-mcp/shared/errors";

/** Bound only the small mutation receipt, not the streamed MIME upload or attachment downloads. */
export async function readMutationReceipt<T>(response: Response): Promise<T> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (!reader) throw new GmailMcpError("internal", "mutation receipt unavailable");
  const until = Date.now() + 15000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("receipt deadline")), 15000);
  });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (Date.now() >= until) throw new Error("receipt deadline");
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new Error("receipt size");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as T;
  } catch {
    // Cancellation must not keep the operation pending if a broken transport never acknowledges it.
    void reader.cancel().catch(() => undefined);
    throw new GmailMcpError("internal", "mutation receipt unavailable");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    reader.releaseLock();
  }
}
