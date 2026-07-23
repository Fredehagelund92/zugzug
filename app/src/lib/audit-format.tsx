/* audit-format — shared formatting for audit_log events: turns raw action codes
 * into plain-English phrases, formats timestamps, and draws the kind glyph.
 * Used by the workspace/admin activity feed (AuditTimeline) and the per-record
 * history drawer so both read the same way. */

import type { ReactNode } from "react";
import type { AuditEntry } from "../store";

/* ────────────────────────── humanize ────────────────────────── */

/* Maps an action code + detail string into a structured sentence:
   { verb, noun?, target? }. Anything we don't recognise falls back to the
   raw action so we never *hide* an event from the reader. */
export interface Phrase {
  verb: string;
  noun?: string;
  target?: string;
  kind: EventKind;
}

export type EventKind =
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
  edited: "update",
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

// Server action codes carry internal vocabulary; translate the display verb and
// noun to the plain words the rest of the UI uses (CLAUDE.md §5, DESIGN.md §2)
// before anything reaches the screen. Anything not listed passes through.
const VERB_PLAIN: Record<string, string> = {
  committed: "published",
  synced: "refreshed",
  replayed: "resent",
};
const NOUN_PLAIN: Record<string, string> = {
  canonical: "record",
};
function plain(p: Phrase): Phrase {
  return {
    ...p,
    verb: VERB_PLAIN[p.verb] ?? p.verb,
    noun: p.noun ? (NOUN_PLAIN[p.noun] ?? p.noun) : p.noun,
  };
}

export function humanize(row: AuditEntry): Phrase {
  const a = row.action;
  const d = row.detail || "";

  // Sentence-case actions: "Added canonical", "Renamed column", …
  const m = a.match(/^([A-Z][a-z-]+)\s+(.+)$/);
  if (m) {
    const verb = m[1]!.toLowerCase();
    const noun = m[2]!.toLowerCase();
    return plain({ verb, noun, target: d || undefined, kind: KIND_BY_VERB[verb] ?? "other" });
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
    return plain({ verb, noun, target: d || undefined, kind: KIND_BY_VERB[verb] ?? "other" });
  }

  // snake_case actions: "scan_failed", "discard_draft", …
  if (a.includes("_")) {
    const [head, ...rest] = a.split("_");
    const tail = rest.join(" ");
    return plain({
      verb: tail || head!,
      noun: tail ? head : undefined,
      target: d || undefined,
      kind: a.endsWith("_failed") ? "system" : "other",
    });
  }

  return plain({ verb: a, target: d || undefined, kind: "other" });
}

/* ────────────────────────── time helpers ────────────────────────── */

/* Force English regardless of the reader's browser locale — otherwise month
   and weekday names render in the OS language and mix into the English UI. */
const LOCALE = "en-US";

function safeDate(s: string): Date | null {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function relativeTime(iso: string): string {
  const d = safeDate(iso);
  if (!d) return iso;
  const diff = Date.now() - d.getTime();
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return d.toLocaleDateString(LOCALE, { month: "short", day: "numeric" });
}

export function absoluteTime(iso: string): string {
  const d = safeDate(iso);
  if (!d) return iso;
  return d.toLocaleString(LOCALE, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function dayBucket(iso: string): { key: string; label: string } {
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
  if (diffDays < 7) return { key, label: evt.toLocaleDateString(LOCALE, { weekday: "long" }) };
  return {
    key,
    label: evt.toLocaleDateString(LOCALE, { month: "long", day: "numeric", year: "numeric" }),
  };
}

/* ────────────────────────── kind glyph ────────────────────────── */

export function KindGlyph({ kind }: { kind: EventKind }) {
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
      style={{
        // Tint over an opaque surface base so the rail can't bleed through the
        // otherwise-translucent fill; the 2px ring masks it at the edge.
        background: `linear-gradient(${g.soft}, ${g.soft}), var(--surface)`,
        color: g.color,
        boxShadow: "0 0 0 2px var(--surface)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 16 16">
        {g.path}
      </svg>
    </span>
  );
}
