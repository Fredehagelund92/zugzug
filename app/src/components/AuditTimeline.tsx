/* AuditTimeline — shared activity feed used by the workspace and admin audit
 *  pages. Groups events by day, humanizes action codes into English, shows
 *  who did what when, and lets the reader expand the raw metadata payload.
 *  The formatting primitives live in `../lib/audit-format` so the per-record
 *  history drawer reads events the same way. */

import { useMemo, useState, type ReactNode } from "react";
import type { AuditEntry } from "../store";
import { absoluteTime, dayBucket, humanize, KindGlyph, relativeTime } from "../lib/audit-format";
import { Panel } from "./Panel";

/* ────────────────────────── component ────────────────────────── */

export interface AuditTimelineProps {
  rows: AuditEntry[];
  /** Optional column shown next to the avatar — used by admin to display the
   *  super-admin badge for elevated actions. */
  renderActorBadge?: (row: AuditEntry) => ReactNode;
  /** Optional renderer for the right-hand secondary slot — admin uses it to
   *  render the tenant tag. */
  renderTag?: (row: AuditEntry) => ReactNode;
}

export function AuditTimeline({ rows, renderActorBadge, renderTag }: AuditTimelineProps) {
  const grouped = useMemo(() => {
    const out: { key: string; label: string; items: AuditEntry[] }[] = [];
    for (const r of rows) {
      const b = dayBucket(r.at);
      const last = out[out.length - 1];
      if (last && last.key === b.key) last.items.push(r);
      else out.push({ ...b, items: [r] });
    }
    return out;
  }, [rows]);

  return (
    <Panel padding="md">
      <div className="space-y-8">
        {grouped.map((g) => (
          <section key={g.key} aria-labelledby={`day-${g.key}`}>
            {/* Day divider reads like a ledger rule: LABEL ──────── N EVENTS */}
            <header className="mb-2 flex items-center gap-3">
              <h2
                id={`day-${g.key}`}
                className="font-mono text-[11px] font-medium uppercase tracking-[0.2em] text-ink-2"
              >
                {g.label}
              </h2>
              <span aria-hidden className="h-px flex-1 bg-line" />
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] tabular-nums text-ink-3">
                {g.items.length} event{g.items.length === 1 ? "" : "s"}
              </span>
            </header>

            <ol className="relative">
              {/* The rail threads the event nodes: anchored glyph-center to
                  glyph-center (14px node ÷ + 12px row pad = 26px), so it never
                  pokes past the end icons and collapses on single-event days. */}
              <span
                aria-hidden
                className="absolute left-[13px] top-[26px] bottom-[26px] w-px"
                style={{ background: "var(--line)" }}
              />
              {g.items.map((row) => (
                <AuditRow
                  key={row.id}
                  row={row}
                  renderActorBadge={renderActorBadge}
                  renderTag={renderTag}
                />
              ))}
            </ol>
          </section>
        ))}
      </div>
    </Panel>
  );
}

function AuditRow({
  row,
  renderActorBadge,
  renderTag,
}: {
  row: AuditEntry;
  renderActorBadge?: (r: AuditEntry) => ReactNode;
  renderTag?: (r: AuditEntry) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const phrase = humanize(row);
  const hasMeta = row.metadata && Object.keys(row.metadata).length > 0;

  return (
    <li className="group relative">
      {/* Full-bleed hover — the whole row is the affordance for expanding metadata.
          Bleeds to the Panel edge (-inset-x-6 matches the Panel's p-6). */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 -inset-x-6 bg-surface-2 opacity-0 transition-opacity duration-150 group-hover:opacity-60"
      />
      <div className="relative flex items-start gap-3 py-3 pl-0 pr-1">
        <KindGlyph kind={phrase.kind} />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className="min-w-0 flex-1 truncate text-[14px] leading-snug text-ink">
              <span className="font-semibold">{row.user.name}</span>{" "}
              <span className="text-ink-2">{phrase.verb}</span>{" "}
              {phrase.noun && <span className="text-ink-2">{phrase.noun}</span>}
              {phrase.target && (
                <>
                  {" — "}
                  <span
                    className="font-mono text-[12.5px] text-ink"
                    style={{ color: "var(--ink)" }}
                  >
                    {phrase.target}
                  </span>
                </>
              )}
            </p>
            {renderTag?.(row)}
            <time
              dateTime={row.at}
              title={absoluteTime(row.at)}
              className="shrink-0 font-mono text-[11px] tabular-nums text-ink-3"
            >
              {relativeTime(row.at)}
            </time>
          </div>

          <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-3">
            {renderActorBadge?.(row)}
            {hasMeta && (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="font-mono text-[10px] uppercase tracking-widest text-ink-3 transition-colors hover:text-ink"
              >
                {open ? "− metadata" : "+ metadata"}
              </button>
            )}
          </div>

          {open && hasMeta && (
            <pre className="rounded-lg zz-rise mt-2 max-h-72 overflow-auto border border-line bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-2">
              {JSON.stringify(row.metadata, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </li>
  );
}
