import { useState } from "react";
import type { BundledLanguage } from "shiki";
import { SigningRecipeBlock } from "./SigningRecipeBlock";
import {
  NODE_RECIPE,
  PYTHON_RECIPE,
  GO_RECIPE,
  EXAMPLE_REQUEST,
  EXAMPLE_ROTATION_SIGNATURE,
} from "./webhook-recipes";
import { Panel } from "../Panel";
import { cx } from "../../lib/cx";

interface Recipe {
  id: string;
  label: string;
  lang: BundledLanguage;
  filename: string;
  code: string;
}

const RECIPES: Recipe[] = [
  { id: "node", label: "Node", lang: "typescript", filename: "verify.ts", code: NODE_RECIPE },
  { id: "python", label: "Python", lang: "python", filename: "verify.py", code: PYTHON_RECIPE },
  { id: "go", label: "Go", lang: "go", filename: "verify.go", code: GO_RECIPE },
];

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
              {EXAMPLE_REQUEST}
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
          <p className="text-[12px] text-ink-2 max-w-prose pt-1">
            During the 24h grace after a rotation the header carries one <code>kid</code>/
            <code>v1</code> pair per key. Accept the delivery if any <code>v1</code> matches your
            secret — that is what lets you cut over at your own pace.
          </p>
          <div className="rounded-sm border border-line bg-surface-2 overflow-hidden">
            <pre className="p-3 overflow-x-auto text-[12px] leading-relaxed font-mono text-ink whitespace-pre">
              {EXAMPLE_ROTATION_SIGNATURE}
            </pre>
          </div>
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
          <SectionLabel n="03" title="Event payload (table.published)" />
          <div className="rounded-sm border border-line bg-surface-2 p-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11.5px]">
              <dt className="font-mono uppercase tracking-wider text-ink-3">table_slug</dt>
              <dd className="text-ink-2">
                Table identifier. The event type is not in the body — read it from{" "}
                <code>x-zugzug-event</code>.
              </dd>
              <dt className="font-mono uppercase tracking-wider text-ink-3">table_label</dt>
              <dd className="text-ink-2">Human-readable table name</dd>
              <dt className="font-mono uppercase tracking-wider text-ink-3">version</dt>
              <dd className="text-ink-2">
                New version number; <code>previous_version</code> is the one it replaced
              </dd>
              <dt className="font-mono uppercase tracking-wider text-ink-3">committed_by</dt>
              <dd className="text-ink-2">
                <code>{`{ id, name }`}</code> of the person who published
              </dd>
              <dt className="font-mono uppercase tracking-wider text-ink-3">changes</dt>
              <dd className="text-ink-2">
                <code>added</code>, <code>remapped</code>, <code>updated</code>, <code>merged</code>
                , <code>retired</code> — capped at 200 entries each
              </dd>
              <dt className="font-mono uppercase tracking-wider text-ink-3">summary</dt>
              <dd className="text-ink-2">Full counts for the same five buckets</dd>
              <dt className="font-mono uppercase tracking-wider text-ink-3">changes_truncated</dt>
              <dd className="text-ink-2">
                Present and <code>true</code> when a bucket was capped — refetch from{" "}
                <code>/v1/tables/&lt;slug&gt;/records</code>
              </dd>
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
            <SpecCard label="Retries" value="5 attempts" note="5s, 30s, 5m, 1h backoff" />
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
