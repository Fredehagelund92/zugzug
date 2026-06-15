/* webhook-signing.ts — HMAC-SHA256 payload signing for outbound webhooks.

   Format (design §5.5):
     t=<unix>,kid=<current|previous>,v1=sha256=<64-hex>
   where hex = HMAC_SHA256(secret, "<unix>.<rawBody>") */

import { createHmac } from "node:crypto";

export type Kid = "current" | "previous";

export function signPayload(rawBody: string, secret: string, kid: Kid, nowSeconds: number): string {
  const hex = createHmac("sha256", secret).update(`${nowSeconds}.${rawBody}`).digest("hex");
  return `t=${nowSeconds},kid=${kid},v1=sha256=${hex}`;
}

export interface SignatureParts {
  t: number;
  kid: Kid;
  v1: string;
}

export function parseSignatureHeader(header: string): SignatureParts | null {
  if (!header || typeof header !== "string") return null;
  const parts: Record<string, string> = {};
  for (const seg of header.split(",")) {
    const eq = seg.indexOf("=");
    if (eq <= 0) return null;
    const k = seg.slice(0, eq).trim();
    const v = seg.slice(eq + 1).trim();
    if (!k || !v) return null;
    parts[k] = v;
  }
  if (!parts.t || !parts.kid || !parts.v1) return null;
  const tNum = Number(parts.t);
  if (!Number.isFinite(tNum)) return null;
  const m = /^sha256=([0-9a-f]+)$/i.exec(parts.v1);
  if (!m) return null;
  if (parts.kid !== "current" && parts.kid !== "previous") return null;
  return { t: tNum, kid: parts.kid as Kid, v1: m[1]! };
}
