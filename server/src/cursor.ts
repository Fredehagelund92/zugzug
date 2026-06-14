/* cursor.ts — HMAC-SHA256-signed pagination cursors for the Pull API (PR2).
   A tampering client cannot fast-forward; rotating ZUGZUG_CURSOR_KEY invalidates
   all in-flight cursors (clients resync from ?since=, benign for a read API).

   Format (design §4.6):
     cursor = base64url(payload) + "." + base64url(HMAC_SHA256(key, payload))
     payload (JSON) = { t, u, k, v } */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface CursorPayload {
  t: string; // tenant_id
  u: string; // last updated_at (ISO 8601)
  k: string; // last key
  v: 1; // cursor format version
}

export type VerifyResult =
  | { ok: true; payload: CursorPayload }
  | { ok: false; reason: "cursor_invalid" | "cursor_mismatch" };

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function keyBuffer(keyB64: string): Buffer {
  return Buffer.from(keyB64, "base64");
}

export function signCursor(payload: CursorPayload, keyB64: string): string {
  const body = JSON.stringify(payload);
  const sig = createHmac("sha256", keyBuffer(keyB64)).update(body).digest();
  return `${b64url(body)}.${b64url(sig)}`;
}

export function verifyCursor(
  cursor: string,
  keyB64: string,
  expectedTenant?: string,
): VerifyResult {
  if (!cursor || typeof cursor !== "string") {
    return { ok: false, reason: "cursor_invalid" };
  }
  const dot = cursor.indexOf(".");
  if (
    dot <= 0 ||
    dot === cursor.length - 1 ||
    cursor.indexOf(".", dot + 1) >= 0
  ) {
    return { ok: false, reason: "cursor_invalid" };
  }
  const bodyB64 = cursor.slice(0, dot);
  const sigB64 = cursor.slice(dot + 1);
  let bodyBuf: Buffer;
  let sigBuf: Buffer;
  try {
    bodyBuf = fromB64url(bodyB64);
    sigBuf = fromB64url(sigB64);
  } catch {
    return { ok: false, reason: "cursor_invalid" };
  }
  const expected = createHmac("sha256", keyBuffer(keyB64))
    .update(bodyBuf)
    .digest();
  if (expected.length !== sigBuf.length || !timingSafeEqual(expected, sigBuf)) {
    return { ok: false, reason: "cursor_invalid" };
  }
  let payload: CursorPayload;
  try {
    payload = JSON.parse(bodyBuf.toString("utf8")) as CursorPayload;
  } catch {
    return { ok: false, reason: "cursor_invalid" };
  }
  if (
    typeof payload.t !== "string" ||
    typeof payload.u !== "string" ||
    typeof payload.k !== "string" ||
    payload.v !== 1
  ) {
    return { ok: false, reason: "cursor_invalid" };
  }
  if (expectedTenant && payload.t !== expectedTenant) {
    return { ok: false, reason: "cursor_mismatch" };
  }
  return { ok: true, payload };
}
