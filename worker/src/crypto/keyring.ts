export type AadParts = { userId: string; accountId: string; field: string };

export function frameAad(p: AadParts): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(["gmail-mcp:v1", p.userId, p.accountId, p.field].join("\0")));
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export class Keyring {
  private readonly keys = new Map<string, CryptoKey>();
  private constructor(private readonly raw: Record<string, string>, public readonly currentKeyId: string) {}

  static fromEnv(env: { TOKEN_KEKS: string; TOKEN_KEK_CURRENT: string }): Keyring {
    const raw = JSON.parse(env.TOKEN_KEKS) as Record<string, string>;
    if (!(env.TOKEN_KEK_CURRENT in raw)) throw new Error("TOKEN_KEK_CURRENT not in TOKEN_KEKS");
    return new Keyring(raw, env.TOKEN_KEK_CURRENT);
  }

  private async key(id: string): Promise<CryptoKey> {
    const cached = this.keys.get(id);
    if (cached) return cached;
    const b64 = this.raw[id];
    if (!b64) throw new Error(`unknown key id ${id}`);
    const bytes = fromB64(b64);
    if (bytes.length !== 32) throw new Error(`key ${id} must be 32 bytes`);
    const k = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
    this.keys.set(id, k);
    return k;
  }

  async encrypt(plain: string, aad: AadParts): Promise<{ ciphertext: Uint8Array<ArrayBuffer>; keyId: string }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await this.key(this.currentKeyId);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: frameAad(aad) }, k, new TextEncoder().encode(plain)));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv, 0);
    out.set(ct, 12);
    return { ciphertext: out, keyId: this.currentKeyId };
  }

  async decrypt(ciphertext: Uint8Array<ArrayBuffer>, keyId: string, aad: AadParts): Promise<string> {
    if (ciphertext.length < 12 + 16) throw new Error("ciphertext too short");
    const k = await this.key(keyId);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ciphertext.slice(0, 12), additionalData: frameAad(aad) }, k, ciphertext.slice(12));
    return new TextDecoder().decode(plain);
  }
}
