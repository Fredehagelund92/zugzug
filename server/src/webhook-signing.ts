/* webhook-signing.ts — HMAC-SHA256 payload signing for outbound webhooks.

   Format (design §5.5):
     t=<unix>,kid=<current|previous>,v1=sha256=<64-hex>
   where hex = HMAC_SHA256(secret, "<unix>.<rawBody>")

   During the 24h rotation grace window a delivery is signed with BOTH keys, so
   the header carries one kid/v1 pair per key in order:
     t=<unix>,kid=current,v1=sha256=<hex>,kid=previous,v1=sha256=<hex>
   A verifier accepts the payload when ANY v1 matches its own secret — that is
   what lets a consumer cut over at any point inside the window. */

import { createHmac } from "node:crypto";

export type Kid = "current" | "previous";

export interface SigningKey {
  kid: Kid;
  secret: string;
}

function digest(rawBody: string, secret: string, nowSeconds: number): string {
  return createHmac("sha256", secret).update(`${nowSeconds}.${rawBody}`).digest("hex");
}

/** Header carrying one signature per key, in the order given. */
export function signPayloadMulti(rawBody: string, keys: SigningKey[], nowSeconds: number): string {
  const pairs = keys.map((k) => `kid=${k.kid},v1=sha256=${digest(rawBody, k.secret, nowSeconds)}`);
  return `t=${nowSeconds},${pairs.join(",")}`;
}

export function signPayload(rawBody: string, secret: string, kid: Kid, nowSeconds: number): string {
  return signPayloadMulti(rawBody, [{ kid, secret }], nowSeconds);
}

export interface SignatureEntry {
  kid: Kid;
  v1: string;
}

export interface SignatureParts {
  t: number;
  /** kid of the first signature. */
  kid: Kid;
  /** hex digest of the first signature. */
  v1: string;
  /** Every signature in the header, in order. Accept if any one matches. */
  entries: SignatureEntry[];
}

export function parseSignatureHeader(header: string): SignatureParts | null {
  if (!header || typeof header !== "string") return null;
  let t: number | null = null;
  let pendingKid: Kid | null = null;
  const entries: SignatureEntry[] = [];
  for (const seg of header.split(",")) {
    const eq = seg.indexOf("=");
    if (eq <= 0) return null;
    const k = seg.slice(0, eq).trim();
    const v = seg.slice(eq + 1).trim();
    if (!k || !v) return null;
    if (k === "t") {
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      t = n;
    } else if (k === "kid") {
      if (v !== "current" && v !== "previous") return null;
      pendingKid = v;
    } else if (k === "v1") {
      const m = /^sha256=([0-9a-f]+)$/i.exec(v);
      if (!m || !pendingKid) return null;
      entries.push({ kid: pendingKid, v1: m[1]! });
      pendingKid = null;
    }
  }
  if (t === null || entries.length === 0) return null;
  return { t, kid: entries[0]!.kid, v1: entries[0]!.v1, entries };
}

export interface DeliveryHeaderInput {
  eventType: string;
  eventId: string;
  deliveryId: string;
  signature: string;
  isTest: boolean;
}

/** The exact header set every outbound delivery carries. It lives here rather
 *  than inline in webhook-dispatcher.ts so the published verification reference
 *  (app/src/components/integrations/webhook-recipes.ts) can be asserted against
 *  the real thing without dragging in the database layer. */
export function deliveryHeaders(input: DeliveryHeaderInput): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": "zugzug-webhook/1",
    "x-zugzug-event": input.eventType,
    "x-zugzug-event-id": input.eventId,
    "x-zugzug-delivery": input.deliveryId,
    "x-zugzug-signature": input.signature,
    "x-zugzug-test": input.isTest ? "1" : "0",
  };
}
