import { useState } from "react";
import { Button } from "../Button";

const RECIPE = `// Node 18+; secrets is { current: string, previous?: string }.
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyZugzugSignature(rawBody: string, header: string, secrets: {
  current: string; previous?: string;
}): boolean {
  // Header: "t=<unix>,kid=<current|previous>,v1=sha256=<hex>"
  const parts: Record<string, string> = {};
  for (const seg of header.split(",")) {
    const eq = seg.indexOf("=");
    if (eq > 0) parts[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
  }
  if (!parts.t || !parts.kid || !parts.v1) return false;
  const skew = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!Number.isFinite(skew) || skew > 300) return false;
  const m = /^sha256=([0-9a-f]{64})$/.exec(parts.v1);
  if (!m) return false;
  const provided = Buffer.from(m[1], "hex");
  const secret = parts.kid === "previous" ? secrets.previous : secrets.current;
  if (!secret) return false;
  const expected = createHmac("sha256", secret)
    .update(parts.t + "." + rawBody)
    .digest();
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}`;

export function SigningRecipeBlock() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative rounded-sm border border-line bg-surface-2">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-3">
          verifyZugzugSignature.ts
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(RECIPE);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="p-3 overflow-x-auto text-[12px] leading-relaxed font-mono text-ink">{RECIPE}</pre>
    </div>
  );
}
