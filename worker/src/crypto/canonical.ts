/**
 * RFC 8785 JSON Canonicalization Scheme over I-JSON input.
 * Anything that is not a plain JSON value is a TypeError: callers canonicalise schema-validated data only.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("non-finite number");
      return JSON.stringify(value);
    case "string":
      if (!value.isWellFormed()) throw new TypeError("lone surrogate in string");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError("non-plain object");
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return (
        "{" +
        keys
          .map((k) => {
            if (!k.isWellFormed()) throw new TypeError("lone surrogate in key");
            return JSON.stringify(k) + ":" + canonicalize(obj[k]);
          })
          .join(",") +
        "}"
      );
    }
    default:
      throw new TypeError(`cannot canonicalize ${typeof value}`);
  }
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hashCanonical(canonical: string): Promise<string> {
  // TextEncoder yields an ArrayBufferLike-backed view; copy into an ArrayBuffer-backed one so it
  // satisfies BufferSource under TypeScript's generic typed arrays.
  return sha256Hex(new Uint8Array(new TextEncoder().encode(canonical)));
}
