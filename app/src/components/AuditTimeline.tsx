/* AuditTimeline — shared activity feed used by the workspace and admin audit
 *  pages. Groups events by day, humanizes action codes into English, shows
 *  who did what when, and lets the reader expand the raw metadata payload. */

import { useMemo, useState, type ReactNode } from "react";
import type { AuditEntry } from "../store";
import { Panel } from "./Panel";

/* ────────────────────────── humanize ────────────────────────── */

/* Maps an action code + detail string into a structured sentence:
   { verb, noun?, target? }. Anything we don't recognise falls back to the
   raw action so we never *hide* an event from the reader. */
interface Phrase {
  verb: string;
  noun?: string;
  target?: string;
  kind: EventKind;
}

type EventKind =
  | "create"
  | "update"
  | "delete"
  | "publish"
  | "connect"
  | "security"
  | "system"
  | "other";

const KIND_BY_VERB: Record<string, EventKind> = {
  added: "create",
  created: "create",
  inserted: "create",
  connected: "connect",
  renamed: "update",
  updated: "update",
  changed: "update",
  reordered: "update",
  rebalanced: "update",
  switched: "update",
  merged: "update",
  retired: "delete",
  deleted: "delete",
  removed: "delete",
  revoked: "security",
  paused: "security",
  reactivated: "update",
  rotated: "security",
  committed: "publish",
  replayed: "publish",
  synced: "publish",
  failed: "system",
  "auto-disabled": "system",
  invited: "security",
};

function humanize(row: AuditEntry): Phrase {
  const a = row.action;
  const d = row.detail || "";

  // Sentence-case actions: "Added canonical", "Renamed column", …
  const m = a.match(/^([A-Z][a-z-]+)\s+(.+)$/);
  if (m) {
    const verb = m[1]!.toLowerCase();
    const noun = m[2]!.toLowerCase();
    return { verb, noun, target: d || undefined, kind: KIND_BY_VERB[verb] ?? "other" };
  }

  // Dotted lower-case actions: "invite.create", "warehouse.database.add", …
  if (a.includes(".")) {
    const parts = a.split(".");
    const last = parts[parts.length - 1] ?? a;
    const noun = parts.slice(0, -1).join(" ");
    const verbMap: Record<string, string> = {
      create: "created",
      add: "added",
      remove: "removed",
      revoke: "revoked",
      role: "changed role on",
      rename: "renamed",
      update: "updated",
    };
    const verb = verbMap[last] ?? last;
    return { verb, noun, target: d || undefined, kind: KIND_BY_VERB[verb] ?? "other" };
  }

  // snake_case actions: "scan_failed", "discard_draft", …
  if (a.includes("_")) {
    const [head, ...rest] = a.split("_");
    const tail = rest.join(" ");
    return {
      verb: tail || head!,
      noun: tail ? head : undefined,
      target: d || undefined,
      kind: a.endsWith("_failed") ? "system" : "other",
    };
  }

  return { verb: a, target: d || undefined, kind: "other" };
}

/* ────────────────────────── time helpers ────────────────────────── */

function safeDate(s: string): Date | null {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function relativeTime(iso: string): string {
  const d = safeDate(iso);
  if (!d) return iso;
  const diff = Date.now() - d.getTime();
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function absoluteTime(iso: string): string {
  const d = safeDate(iso);
  if (!d) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function dayBucket(iso: string): { key: string; label: string } {
  const d = safeDate(iso);
  if (!d) return { key: "unknown", label: "Unknown date" };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const evt = new Date(d);
  evt.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - evt.getTime()) / 86_400_000);
  const key = evt.toISOString().slice(0, 10);
  if (diffDays === 0) return { key, label: "Today" };
  if (diffDays === 1) return { key, label: "Yesterday" };
  if (diffDays < 7) return { key, label: evt.toLocaleDateString(undefined, { weekday: "long" }) };
  return {
    key,
    label: evt.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }),
  };
}

/* ────────────────────────── icons ────────────────────────── */

function KindGlyph({ kind }: { kind: EventKind }) {
  const map: Record<EventKind, { color: string; soft: string; path: ReactNode }> = {
    create: {
      color: "var(--tint-mint)",
      soft: "color-mix(in srgb, var(--tint-mint) 16%, transparent)",
      path: (
        <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      ),
    },
    update: {
      color: "var(--accent-2)",
      soft: "color-mix(in srgb, var(--accent-2) 18%, transparent)",
      path: (
        <path
          d="M3 11l4-4 3 3 3-5M10 5h3v3"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      ),
    },
    delete: {
      color: "var(--tint-coral)",
      soft: "color-mix(in srgb, var(--tint-coral) 18%, transparent)",
      path: <path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
    },
    publish: {
      color: "var(--accent)",
      soft: "color-mix(in srgb, var(--accent) 18%, transparent)",
      path: (
        <path
          d="M3 12l5-9 5 9-5-3-5 3z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
          fill="none"
        />
      ),
    },
    connect: {
      color: "var(--tint-teal)",
      soft: "color-mix(in srgb, var(--tint-teal) 18%, transparent)",
      path: (
        <path
          d="M5 8a2 2 0 1 1 0-0.01M11 8a2 2 0 1 1 0-0.01M7 8h2"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
      ),
    },
    security: {
      color: "var(--tint-violet)",
      soft: "color-mix(in srgb, var(--tint-violet) 18%, transparent)",
      path: (
        <path
          d="M8 2.5l4.5 1.5v3.5c0 2.8-2 5-4.5 6-2.5-1-4.5-3.2-4.5-6V4L8 2.5z"
          stroke="currentColor"
          strokeWidth="1.4"
          fill="none"
          strokeLinejoin="round"
        />
      ),
    },
    system: {
      color: "var(--ink-3)",
      soft: "color-mix(in srgb, var(--ink-3) 22%, transparent)",
      path: (
        <path
          d="M8 4.5v3.7M8 11.2v.1"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      ),
    },
    other: {
      color: "var(--ink-3)",
      soft: "color-mix(in srgb, var(--ink-3) 18%, transparent)",
      path: <circle cx="8" cy="8" r="2.2" fill="currentColor" />,
    },
  };
  const g = map[kind];
  return (
    <span
      aria-hidden
      className="relative z-10 inline-flex h-7 w-7 items-center justify-center rounded-full"
      style={{ background: g.soft, color: g.color, boxShadow: "0 0 0 2px var(--surface)" }}
    >
      <svg width="14" height="14" viewBox="0 0 16 16">
        {g.path}
      </svg>
    </span>
  );
}

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
              {/* The rail threads the event nodes; trimmed to the first/last node. */}
              <span
                aria-hidden
                className="absolute left-[13px] top-5 bottom-5 w-px"
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
            <code className="font-mono">{row.action}</code>
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
            <pre className="zz-rise mt-2 max-h-72 overflow-auto border border-line bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-2">
              {JSON.stringify(row.metadata, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </li>
  );
}
