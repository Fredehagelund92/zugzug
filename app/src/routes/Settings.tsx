import { useState } from "react";
import { Card } from "../components/Card";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { cx } from "../lib/cx";
import { useEngineerMode } from "../lib/engineer-mode";

/* Settings — workspace, appearance (theme), the DuckDB connection, and matching
   defaults. Token-driven, squared. UI only. */

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card className="p-0">
      <div className="border-b border-line px-6 py-4">
        <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
        {hint && <p className="mt-0.5 text-[13px] text-ink-2">{hint}</p>}
      </div>
      <div className="space-y-5 px-6 py-5">{children}</div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="font-mono text-[11px] uppercase tracking-wider text-ink-3">{label}</span>
      {children}
    </label>
  );
}

const input = "w-full max-w-sm rounded-sm border border-line-2 bg-bg px-3 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent";

export function Settings() {
  const { engineer, setEngineer } = useEngineerMode();
  const [threshold, setThreshold] = useState(90);
  const [autoAccept, setAutoAccept] = useState(true);
  const [saved, setSaved] = useState(false);
  const save = () => { setSaved(true); setTimeout(() => setSaved(false), 2200); };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="zz-rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-3">Workspace</div>
          <h1 className="mt-1.5 font-display text-[clamp(28px,4vw,44px)] font-extrabold leading-none tracking-[-0.035em] text-ink">Settings</h1>
        </div>
        <div className="flex items-center gap-3">
          {saved && <span className="font-mono text-[12px] text-ok">✓ saved</span>}
          <Button onClick={save}>Save changes</Button>
        </div>
      </div>

      <div className="zz-rise" style={{ animationDelay: "60ms" }}>
        <Section title="Workspace">
          <Field label="Name"><input className={input} defaultValue="Better Collective · Data" /></Field>
        </Section>
      </div>

      <div className="zz-rise" style={{ animationDelay: "100ms" }}>
        <Section title="Appearance" hint="Theme follows the toggle in the top bar.">
          <Field label="Engineer details">
            <button type="button" onClick={() => setEngineer(!engineer)} className="flex items-center gap-3 text-left">
              <span className={cx("relative h-5 w-9 rounded-pill border transition-colors", engineer ? "border-accent bg-accent" : "border-line-2 bg-surface-2")}>
                <span className={cx("absolute top-0.5 h-3.5 w-3.5 rounded-pill bg-surface transition-all", engineer ? "left-4" : "left-0.5")} />
              </span>
              <span className="text-[13px] text-ink-2">Show warehouse table names, SQL, and join warnings</span>
            </button>
          </Field>
        </Section>
      </div>

      <div className="zz-rise" style={{ animationDelay: "140ms" }}>
        <Section title="Connections" hint={engineer ? "Reads your warehouse (MotherDuck), writes master records to its own MotherDuck database, and keeps multi-user app state in Postgres." : "Where Zug Zug is connected."}>
          {engineer ? (
            <>
              <div className="rounded-sm border border-line bg-bg p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2"><span className="font-display text-[14px] font-semibold text-ink">Warehouse</span><Badge>read-only</Badge></div>
                  <Badge tone="ok" dot>connected</Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-3">
                  <span className="text-ink-2">md:analytics</span><span>·</span><span>attached &amp; scanned for source values — never written to</span>
                </div>
              </div>
              <div className="rounded-sm border border-line bg-bg p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2"><span className="font-display text-[14px] font-semibold text-ink">Master store</span><Badge>MotherDuck</Badge></div>
                  <Badge tone="ok" dot>connected</Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-3">
                  <span className="text-ink-2">md:zugzug</span><span>·</span><span>its own database — every dim_* master + map_* lookup dbt joins</span>
                </div>
              </div>
              <div className="rounded-sm border border-line bg-bg p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2"><span className="font-display text-[14px] font-semibold text-ink">App state</span><Badge tone="accent">Postgres</Badge></div>
                  <Badge tone="ok" dot>connected</Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-3">
                  <span className="text-ink-2">postgres://zugzug</span><span>·</span><span>drafts, audit log, users &amp; presence — the multi-user layer</span>
                </div>
              </div>
              <p className="font-mono text-[10.5px] leading-relaxed text-ink-3">DuckDB <span className="text-ink-2">ATTACH … (TYPE postgres)</span> bridges them — a single scan can join live drafts ⋈ master ⋈ warehouse.</p>
            </>
          ) : (
            <>
              <div className="rounded-sm border border-line bg-bg p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-display text-[14px] font-semibold text-ink">Warehouse</span>
                  <Badge tone="ok" dot>connected</Badge>
                </div>
                <div className="mt-1 text-[12.5px] text-ink-3">Reading from your warehouse — read-only.</div>
              </div>
              <div className="rounded-sm border border-line bg-bg p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-display text-[14px] font-semibold text-ink">Master store</span>
                  <Badge tone="ok" dot>connected</Badge>
                </div>
                <div className="mt-1 text-[12.5px] text-ink-3">Stores every master list — this is what downstream models pick up.</div>
              </div>
              <div className="rounded-sm border border-line bg-bg p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-display text-[14px] font-semibold text-ink">Workspace</span>
                  <Badge tone="ok" dot>connected</Badge>
                </div>
                <div className="mt-1 text-[12.5px] text-ink-3">Drafts, history, and your team — the collaborative layer.</div>
              </div>
            </>
          )}
        </Section>
      </div>

      <div className="zz-rise" style={{ animationDelay: "180ms" }}>
        <Section title="Matching defaults" hint="How aggressively Zug Zug matches new values when a scan finds them.">
          <Field label={`Auto-match confidence threshold — ${threshold}%`}>
            <input type="range" min={50} max={100} value={threshold} onChange={(e) => setThreshold(+e.target.value)} className="w-full max-w-sm accent-[var(--accent)]" />
          </Field>
          <button type="button" onClick={() => setAutoAccept((v) => !v)} className="flex items-center gap-3 text-left">
            <span className={cx("relative h-5 w-9 rounded-pill border transition-colors", autoAccept ? "border-accent bg-accent" : "border-line-2 bg-surface-2")}>
              <span className={cx("absolute top-0.5 h-3.5 w-3.5 rounded-pill bg-surface transition-all", autoAccept ? "left-4" : "left-0.5")} />
            </span>
            <span className="text-[13px] text-ink-2">Auto-match suggestions above the threshold when a scan runs</span>
          </button>
        </Section>
      </div>
    </div>
  );
}
