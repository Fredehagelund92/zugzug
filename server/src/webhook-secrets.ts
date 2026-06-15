/* webhook-secrets.ts — webhook signing-secret lifecycle.

   Production loads the AES-256-GCM master key once at scheduler boot
   (resolveMasterKey from PR1's crypto-secret.ts). Tests inject a stub
   key via _setMasterKeyForTest.

   The plaintext secret is shown to the admin once at create / rotate.
   At-rest we store (ciphertext, nonce, keyVersion) per design §4.2. */

import { encryptSecret, decryptSecret, resolveMasterKey } from "./crypto-secret.ts";
import { env } from "./env.ts";

let masterKey: Buffer | null = null;

export function loadMasterKey(): Buffer {
  if (masterKey) return masterKey;
  const key = resolveMasterKey({
    envKey: env.webhookMasterKeyB64,
    file: env.webhookMasterKeyFile,
    selfHosted: env.selfHosted,
  });
  if (!key) {
    throw new Error("webhook master key not configured — set ZUGZUG_WEBHOOK_MASTER_KEY");
  }
  masterKey = key;
  return masterKey;
}

/** For tests only. Bypasses env.* resolution. */
export function _setMasterKeyForTest(key: Buffer): void {
  masterKey = key;
}

export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `whsec_${Buffer.from(bytes).toString("base64url")}`;
}

export interface EncryptedSecret {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  keyVersion: number;
  prefix: string;
}

export function encryptWebhookSecret(plaintext: string): EncryptedSecret {
  const { ciphertext, nonce, keyVersion } = encryptSecret(plaintext, loadMasterKey(), 1);
  return { ciphertext, nonce, keyVersion, prefix: plaintext.slice(0, 12) };
}

export function decryptWebhookSecret(input: {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  keyVersion: number;
}): string {
  return decryptSecret(input.ciphertext, input.nonce, loadMasterKey(), input.keyVersion);
}
