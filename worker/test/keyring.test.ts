import { describe, it, expect } from "vitest";
import { Keyring, frameAad } from "../src/crypto/keyring";
import { randomHandle, randomId } from "../src/crypto/random";

const k1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const k2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const envLike = { TOKEN_KEKS: JSON.stringify({ k1, k2 }), TOKEN_KEK_CURRENT: "k2" };
const aad = { userId: "u", accountId: "a", field: "refresh_token" };

describe("keyring", () => {
  it("round-trips with the current key", async () => {
    const kr = Keyring.fromEnv(envLike);
    const { ciphertext, keyId } = await kr.encrypt("secret", aad);
    expect(keyId).toBe("k2");
    expect(await kr.decrypt(ciphertext, keyId, aad)).toBe("secret");
  });
  it("decrypts with an older key in the ring", async () => {
    const kr = Keyring.fromEnv({ ...envLike, TOKEN_KEK_CURRENT: "k1" });
    const { ciphertext } = await kr.encrypt("old", aad);
    expect(await Keyring.fromEnv(envLike).decrypt(ciphertext, "k1", aad)).toBe("old");
  });
  it("fails on AAD mismatch, unknown key id, truncated ciphertext", async () => {
    const kr = Keyring.fromEnv(envLike);
    const { ciphertext, keyId } = await kr.encrypt("s", aad);
    await expect(kr.decrypt(ciphertext, keyId, { ...aad, accountId: "other" })).rejects.toThrow();
    await expect(kr.decrypt(ciphertext, "nope", aad)).rejects.toThrow(/unknown key/);
    await expect(kr.decrypt(ciphertext.slice(0, 20), keyId, aad)).rejects.toThrow();
  });
  it("frames AAD with NUL separators and a version prefix", () => {
    expect(new TextDecoder().decode(frameAad(aad))).toBe("gmail-mcp:v1\0u\0a\0refresh_token");
  });
  it("makes distinct ids and handles of the documented shape", () => {
    expect(randomId("op")).toMatch(/^op_[A-Za-z0-9_-]{22}$/);
    expect(randomHandle()).toMatch(/^sh_[A-Za-z0-9_-]{43}$/);
    expect(randomHandle()).not.toBe(randomHandle());
  });
});
