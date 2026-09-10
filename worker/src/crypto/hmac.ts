import { b64url, fromB64url } from "./random";

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function mac(
  keyB64: string,
  purpose: string,
  fields: string[],
  expiresAt: number,
): Promise<Uint8Array<ArrayBuffer>> {
  // Length-prefixed framing: every value is preceded by its byte length, so no content, NUL included,
  // can move a boundary. The purpose comes first so a token minted for one use cannot be replayed as another.
  const enc = new TextEncoder();
  const parts = [purpose, ...fields, String(expiresAt)].map((v) => {
    const bytes = enc.encode(v);
    return `${bytes.length}:${v}|`;
  });
  const input = parts.join("");
  const key = await crypto.subtle.importKey("raw", keyBytes(keyB64), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array(new TextEncoder().encode(input))));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export async function signToken(keyB64: string, purpose: string, fields: string[], expiresAt: number): Promise<string> {
  return `${expiresAt}.${b64url(await mac(keyB64, purpose, fields, expiresAt))}`;
}

export async function verifyToken(
  keyB64: string,
  purpose: string,
  fields: string[],
  token: string,
  now = Date.now(),
): Promise<boolean> {
  const m = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return false;
  const expiresAt = Number(m[1]);
  if (!(expiresAt > now)) return false;
  let given: Uint8Array;
  try {
    given = fromB64url(m[2]!);
  } catch {
    return false;
  }
  return equal(given, await mac(keyB64, purpose, fields, expiresAt));
}
