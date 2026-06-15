import { describe, it, expect, beforeAll } from "bun:test";
import {
  encryptWebhookSecret,
  decryptWebhookSecret,
  generateWebhookSecret,
  _setMasterKeyForTest,
} from "./webhook-secrets.ts";
import { generateMasterKeyB64 } from "./crypto-secret.ts";

beforeAll(() => {
  _setMasterKeyForTest(Buffer.from(generateMasterKeyB64(), "base64"));
});

describe("generateWebhookSecret", () => {
  it("emits 'whsec_' + 43+ chars", () => {
    const v = generateWebhookSecret();
    expect(v.startsWith("whsec_")).toBe(true);
    expect(v.length).toBeGreaterThan(40);
  });
});

describe("encrypt + decrypt round-trip", () => {
  it("survives encrypt → decrypt", () => {
    const plain = "whsec_test1234567890ABCDEFGHIJK";
    const enc = encryptWebhookSecret(plain);
    expect(enc.keyVersion).toBe(1);
    expect(enc.prefix).toBe(plain.slice(0, 12));
    const dec = decryptWebhookSecret({
      ciphertext: enc.ciphertext,
      nonce: enc.nonce,
      keyVersion: enc.keyVersion,
    });
    expect(dec).toBe(plain);
  });

  it("decrypt with wrong nonce throws", () => {
    const enc = encryptWebhookSecret("plain");
    expect(() =>
      decryptWebhookSecret({
        ciphertext: enc.ciphertext,
        nonce: new Uint8Array(12).fill(0xff),
        keyVersion: enc.keyVersion,
      }),
    ).toThrow();
  });
});
