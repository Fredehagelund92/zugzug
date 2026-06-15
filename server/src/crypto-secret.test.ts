import { describe, it, expect } from "bun:test";
import { encryptSecret, decryptSecret, resolveMasterKey } from "./crypto-secret.ts";

const TEST_KEY_B64 = Buffer.alloc(32, 0xab).toString("base64");

describe("encryptSecret + decryptSecret round-trip", () => {
  it("plaintext survives encrypt → decrypt under the same key", () => {
    const key = Buffer.from(TEST_KEY_B64, "base64");
    const plaintext = "whsec_b8K3kP9mQ2vN7L4xR8jH3sT5uW8yA1zE6cD9fG2J";
    const { ciphertext, nonce, keyVersion } = encryptSecret(plaintext, key, 1);
    expect(ciphertext).toBeInstanceOf(Uint8Array);
    expect(nonce.byteLength).toBe(12);
    expect(keyVersion).toBe(1);
    const recovered = decryptSecret(ciphertext, nonce, key, 1);
    expect(recovered).toBe(plaintext);
  });

  it("tampered ciphertext throws", () => {
    const key = Buffer.from(TEST_KEY_B64, "base64");
    const { ciphertext, nonce } = encryptSecret("hello", key, 1);
    ciphertext[0] ^= 0xff;
    expect(() => decryptSecret(ciphertext, nonce, key, 1)).toThrow();
  });

  it("wrong key throws", () => {
    const key1 = Buffer.from(TEST_KEY_B64, "base64");
    const key2 = Buffer.alloc(32, 0xcd);
    const { ciphertext, nonce } = encryptSecret("hello", key1, 1);
    expect(() => decryptSecret(ciphertext, nonce, key2, 1)).toThrow();
  });

  it("nonces differ across calls for the same plaintext", () => {
    const key = Buffer.from(TEST_KEY_B64, "base64");
    const a = encryptSecret("same", key, 1);
    const b = encryptSecret("same", key, 1);
    expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false);
  });
});

describe("resolveMasterKey", () => {
  it("returns the env-var key when present", () => {
    const key = resolveMasterKey({ envKey: TEST_KEY_B64, file: null, selfHosted: false });
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
  });

  it("throws when neither env nor file is set on hosted SaaS", () => {
    expect(() => resolveMasterKey({ envKey: null, file: null, selfHosted: false })).toThrow(
      /master key/i,
    );
  });

  it("self-host with no key + no file returns null (caller auto-generates)", () => {
    expect(resolveMasterKey({ envKey: null, file: null, selfHosted: true })).toBeNull();
  });
});
