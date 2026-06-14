import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../env.ts";

const ALGO = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function key(): Buffer {
  const raw = Buffer.from(env.warehouseEncryptionKey, "base64");
  if (raw.length !== 32) {
    throw new Error(
      `WAREHOUSE_ENCRYPTION_KEY must decode to 32 raw bytes (got ${raw.length}); generate one with \`openssl rand -base64 32\``,
    );
  }
  return raw;
}

export function encryptCredentials(plaintext: string, aad: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, key(), nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]).toString("base64");
}

export function decryptCredentials(blob: string, aad: string): string {
  const raw = Buffer.from(blob, "base64");
  if (raw.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error("ciphertext too short to be valid AES-GCM output");
  }
  const nonce = raw.subarray(0, NONCE_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ct = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key(), nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
