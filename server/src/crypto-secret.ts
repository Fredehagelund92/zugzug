/* crypto-secret.ts — AES-256-GCM encryption for webhook signing secrets.
   Webhook secrets are signing keys, not passwords — we need the plaintext on
   every delivery to compute HMAC_SHA256, so we cannot argon2-hash them.

   See design §4.2 for master-key resolution policy. */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const ALGO = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedSecret {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  keyVersion: number;
}

export function encryptSecret(plaintext: string, key: Buffer, keyVersion: number): EncryptedSecret {
  if (key.length !== 32) throw new Error("master key must be 32 bytes");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([enc, tag]), nonce, keyVersion };
}

export function decryptSecret(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: Buffer,
  keyVersion: number,
): string {
  if (key.length !== 32) throw new Error("master key must be 32 bytes");
  if (ciphertext.length < TAG_BYTES) throw new Error("ciphertext too short");
  void keyVersion; // reserved for multi-version key lookup; v1 has version 1 only
  const enc = Buffer.from(ciphertext.subarray(0, ciphertext.length - TAG_BYTES));
  const tag = Buffer.from(ciphertext.subarray(ciphertext.length - TAG_BYTES));
  const decipher = createDecipheriv(ALGO, key, Buffer.from(nonce));
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

export interface ResolveOpts {
  envKey: string | null;
  file: string | null;
  selfHosted: boolean;
}

export function resolveMasterKey(opts: ResolveOpts): Buffer | null {
  if (opts.envKey) {
    const buf = Buffer.from(opts.envKey, "base64");
    if (buf.length !== 32) {
      throw new Error(
        "ZUGZUG_WEBHOOK_MASTER_KEY must decode to 32 bytes (base64 of 32 random bytes)",
      );
    }
    return buf;
  }
  if (opts.file) {
    const raw = readFileSync(opts.file).toString("utf8").trim();
    const buf = Buffer.from(raw, "base64");
    if (buf.length !== 32) {
      throw new Error(
        `ZUGZUG_WEBHOOK_MASTER_KEY_FILE (${opts.file}) must contain base64 of 32 bytes`,
      );
    }
    return buf;
  }
  if (opts.selfHosted) return null;
  throw new Error(
    "webhook master key required; set ZUGZUG_WEBHOOK_MASTER_KEY or ZUGZUG_WEBHOOK_MASTER_KEY_FILE, or set ZUGZUG_SELF_HOSTED=1 to auto-generate on first boot",
  );
}

/** Generates a fresh 32-byte AES-GCM master key, base64-encoded. */
export function generateMasterKeyB64(): string {
  return randomBytes(32).toString("base64");
}
