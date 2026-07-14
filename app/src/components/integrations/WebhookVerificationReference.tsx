import { useState } from "react";
import type { BundledLanguage } from "shiki";
import { SigningRecipeBlock } from "./SigningRecipeBlock";
import { Panel } from "../Panel";
import { cx } from "../../lib/cx";

interface Recipe {
  id: string;
  label: string;
  lang: BundledLanguage;
  filename: string;
  code: string;
}

const NODE_RECIPE = `import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(rawBody: string, header: string, secret: string): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((s) => s.split("=", 2) as [string, string]),
  );
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const sig = (parts.v1 ?? "").replace(/^sha256=/, "");
  const expected = createHmac("sha256", secret)
    .update(\`\${parts.t}.\${rawBody}\`)
    .digest("hex");
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}`;

const PYTHON_RECIPE = `import hmac, hashlib, time

def verify(raw_body: bytes, header: str, secret: str) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    if abs(time.time() - int(parts["t"])) > 300:
        return False
    sig = parts["v1"].removeprefix("sha256=")
    expected = hmac.new(
        secret.encode(),
        f"{parts['t']}.".encode() + raw_body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, sig)`;

const GO_RECIPE = `package zugzug

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "math"
    "strconv"
    "strings"
    "time"
)

func Verify(rawBody []byte, header, secret string) bool {
    parts := map[string]string{}
    for _, p := range strings.Split(header, ",") {
        if kv := strings.SplitN(p, "=", 2); len(kv) == 2 {
            parts[kv[0]] = kv[1]
        }
    }
    t, err := strconv.ParseInt(parts["t"], 10, 64)
    if err != nil || math.Abs(float64(time.Now().Unix()-t)) > 300 {
        return false
    }
    sig, err := hex.DecodeString(strings.TrimPrefix(parts["v1"], "sha256="))
    if err != nil {
        return false
    }
    mac := hmac.New(sha256.New, []byte(secret))
    mac.Write([]byte(parts["t"] + "." + string(rawBody)))
    return hmac.Equal(mac.Sum(nil), sig)
}`;

const RECIPES: Recipe[] = [
  { id: "node", label: "Node", lang: "typescript", filename: "verify.ts", code: NODE_RECIPE },
  { id: "python", label: "Python", lang: "python", filename: "verify.py", code: PYTHON_RECIPE },
  { id: "go", label: "Go", lang: "go", filename: "verify.go", code: GO_RECIPE },
];

const EXAMPLE_HEADERS = `POST /your-endpoint HTTP/1.1
Host: your-app.example
Content-Type: application/json
Zugzug-Signature: t=1718457600,kid=current,v1=sha256=4f8a1e…
Zugzug-Delivery: 0f8e3a7c-2d6b-4c1f-9a4e-7b8c1d2e3f40

{"event":"dimension.committed","dimension":"country","kind":"publish"}`;

export function WebhookVerificationReference() {
  const [active, setActive] = useState<string>("node");
  const recipe = RECIPES.find((r) => r.id === active) ?? RECIPES[0];

  return (
    <Panel as="section" padding="none">
      <header className="flex items-baseline gap-3 px-4 py-3 border-b border-line">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
          Reference
        </span>
        <h3 className="font-display text-[14px] font-semibold text-ink">
          Verify webhook signatures
        </h3>
      </header>

      <div className="p-4 space-y-6">
        <p className="text-[13px] text-ink-2 max-w-prose">
          Every delivery is signed with HMAC-SHA256 over <code>{`{t}.{rawBody}`}</code>. Verify
          before trusting the payload — reject anything with a timestamp older than 5 minutes or a
          signature mismatch.
        </p>

        <section className="space-y-2">
          <SectionLabel n="01" title="Example request" />
          <div className="rounded-sm border border-line bg-surface-2 overflow-hidden">
            <pre className="p-3 overflow-x-auto text-[12px] leading-relaxed font-mono text-ink whitespace-pre">
              {EXAMPLE_HEADERS}
            </pre>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px] pt-1">
            <dt className="font-mono uppercase tracking-wider text-ink-3">t</dt>
            <dd className="text-ink-2">Unix seconds when signed</dd>
            <dt className="font-mono uppercase tracking-wider text-ink-3">kid</dt>
            <dd className="text-ink-2">
              <code>current</code> normally; <code>previous</code> during rotation grace
            </dd>
            <dt className="font-mono uppercase tracking-wider text-ink-3">v1</dt>
            <dd className="text-ink-2">
              <code>sha256=&lt;hex&gt;</code> over <code>{`{t}.{rawBody}`}</code>
            </dd>
          </dl>
        </section>

        <section className="space-y-2">
          <SectionLabel n="02" title="Verifier" />
          <div
            role="tablist"
            aria-label="Verifier language"
            className="flex items-center gap-0 border-b border-line"
          >
            {RECIPES.map((r) => (
              <button
                key={r.id}
                role="tab"
                aria-selected={active === r.id}
                onClick={() => setActive(r.id)}
                className={cx(
                  "relative px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] transition-colors",
                  active === r.id ? "text-ink" : "text-ink-3 hover:text-ink-2",
                )}
              >
                {r.label}
                {active === r.id && (
                  <span className="absolute left-2 right-2 -bottom-px h-[2px] bg-accent" />
                )}
              </button>
            ))}
          </div>
          <SigningRecipeBlock
            key={recipe.id}
            code={recipe.code}
            lang={recipe.lang}
            filename={recipe.filename}
          />
        </section>

        <section className="space-y-2">
          <SectionLabel n="03" title="Event payload (dimension.committed)" />
          <div className="rounded-sm border border-line bg-surface-2 p-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11.5px]">
              <dt className="font-mono uppercase tracking-wider text-ink-3">event</dt>
              <dd className="text-ink-2">
                <code>dimension.committed</code>
              </dd>
              <dt className="font-mono uppercase tracking-wider text-ink-3">dimension</dt>
              <dd className="text-ink-2">Dimension ID</dd>
              <dt className="font-mono uppercase tracking-wider text-ink-3">kind</dt>
              <dd className="text-ink-2">
                <code>publish</code> or <code>rollback</code>
              </dd>
              <dt className="font-mono uppercase tracking-wider text-ink-3">restores_version</dt>
              <dd className="text-ink-2">Version number on rollbacks; omitted on publishes</dd>
            </dl>
          </div>
          <p className="text-[12px] text-ink-2 max-w-prose">
            Rollbacks arrive as a normal publish with <code>kind: &quot;rollback&quot;</code> and
            the version they restore — downstream systems that ignore these fields stay correct.
          </p>
        </section>

        <section className="space-y-2">
          <SectionLabel n="04" title="Delivery semantics" />
          <div className="grid gap-2 sm:grid-cols-3">
            <SpecCard
              label="Timestamp window"
              value="±5 min"
              note="Reject if abs(now − t) > 300s"
            />
            <SpecCard label="Retries" value="6 attempts" note="2s, 30s, 5m, 30m, 2h, 12h backoff" />
            <SpecCard
              label="Key rotation"
              value="kid=previous"
              note="Valid during 24h overlap window"
            />
          </div>
        </section>
      </div>
    </Panel>
  );
}

function SectionLabel({ n, title }: { n: string; title: string }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-accent">{n}</span>
      <h4 className="font-display text-[13px] font-semibold text-ink">{title}</h4>
    </div>
  );
}

function SpecCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-sm border border-line bg-surface-2 p-3 space-y-1">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">{label}</div>
      <div className="font-display text-[14px] font-semibold text-ink">{value}</div>
      <div className="text-[11.5px] text-ink-2 font-mono">{note}</div>
    </div>
  );
}
