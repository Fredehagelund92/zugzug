import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "../lib/cx";
import { useScrollLock } from "../lib/use-scroll-lock";
import { IconSearch } from "./Icons";

/* CommandPalette — global quick-switcher modal (Cmd+K). Reusable: takes a
   flat Command[] keyed by group, filters by substring match against
   label/secondary/keywords, lets the user keyboard through results with
   ArrowUp/Down/Enter/Esc. Click-outside or Esc closes.

   App-specific data (refTables, routes, record records) lives in the caller;
   this component knows nothing about the domain. */

export interface Command {
  id: string; // stable across re-renders so highlight survives
  group: string; // section header in the result list
  label: string; // primary display text
  secondary?: string; // refTable caption (path, count, type)
  icon?: ReactNode; // leading 14×14 icon
  keywords?: string; // extra match text (e.g. refTable id, slug, key)
  /** Show on initial open (empty search). Non-priority items appear only after
   *  the user starts typing — keeps the resting palette short instead of
   *  dumping every refTable + record record at once. */
  priority?: boolean;
  action: () => void; // executed on selection; close happens before
}

interface Props {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  /** Ordered command ids (most-recent first) shown in a "Recent" group above
   *  Navigate when the search is empty. Recent items are hidden from their
   *  original group to avoid duplicates. Stale ids (no matching command) are
   *  silently skipped. */
  recents?: string[];
  /** Called with the command id just before its action runs, so the caller
   *  can update its recents list. */
  onRun?: (id: string) => void;
  /** Optional placeholder for the search input. */
  placeholder?: string;
}

export function CommandPalette({
  open,
  onClose,
  commands,
  recents = [],
  onRun,
  placeholder = "Jump to anything…",
}: Props) {
  const [q, setQ] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  // Filter commands by substring across label/secondary/keywords. Group
  // ordering preserved from the caller — within a group, original order wins.
  // Empty query collapses to priority items only so the palette doesn't dump
  // its full corpus on the user before they type anything.
  const filtered = useMemo<Command[]>(() => {
    const norm = q.trim().toLowerCase();
    if (!norm) {
      // Empty: prepend Recent commands (in order), then priority commands
      // not already in recents. Stale recent ids skipped silently.
      const byId = new Map(commands.map((c) => [c.id, c]));
      const seen = new Set<string>();
      const out: Command[] = [];
      for (const id of recents) {
        const c = byId.get(id);
        if (!c || seen.has(id)) continue;
        seen.add(id);
        out.push({ ...c, group: "Recent" });
      }
      for (const c of commands) {
        if (!c.priority || seen.has(c.id)) continue;
        out.push(c);
      }
      return out;
    }
    return commands.filter((c) => {
      const hay = `${c.label} ${c.secondary ?? ""} ${c.keywords ?? ""} ${c.group}`.toLowerCase();
      return hay.includes(norm);
    });
  }, [commands, q, recents]);

  // Counts for the empty-state hint — "type to search 12 refTables, 87 records"
  const hiddenSummary = useMemo(() => {
    const norm = q.trim();
    if (norm) return null;
    const groups = new Map<string, number>();
    for (const c of commands) {
      if (c.priority) continue;
      groups.set(c.group, (groups.get(c.group) ?? 0) + 1);
    }
    if (groups.size === 0) return null;
    return [...groups].map(([g, n]) => `${n.toLocaleString()} ${g.toLowerCase()}`).join(" · ");
  }, [commands, q]);

  // Group while preserving order of first appearance.
  const grouped = useMemo(() => {
    const groups: Array<{ group: string; items: Command[] }> = [];
    const byName = new Map<string, Command[]>();
    for (const c of filtered) {
      if (!byName.has(c.group)) {
        const arr: Command[] = [];
        byName.set(c.group, arr);
        groups.push({ group: c.group, items: arr });
      }
      byName.get(c.group)!.push(c);
    }
    return groups;
  }, [filtered]);

  // Reset on open / filter change; clamp on result shrink.
  useEffect(() => {
    if (open) {
      setQ("");
      setHighlight(0);
    }
  }, [open]);
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  // Close on Esc anywhere (not just inside the modal — open globally, close globally).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useScrollLock(open);

  if (!open) return null;

  const runAt = (i: number) => {
    const c = filtered[i];
    if (!c) return;
    onRun?.(c.id);
    onClose();
    // Defer the action a tick so the close transition starts first and any
    // navigation that follows isn't fighting the modal's unmount.
    queueMicrotask(() => c.action());
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (filtered.length === 0 ? 0 : (h + 1) % filtered.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) =>
        filtered.length === 0 ? 0 : (h - 1 + filtered.length) % filtered.length,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(highlight);
    }
  };

  // Compute the absolute index of each item so highlight is a single global
  // counter — keeps the kbd navigation consistent across group boundaries.
  let runningIdx = 0;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex justify-center bg-ink/40 backdrop-blur-sm max-md:items-start md:p-4 md:pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="zz-pop-in w-full overflow-hidden border border-line-2 bg-surface-elevated shadow-pop max-md:inset-x-0 max-md:top-0 max-md:rounded-none max-md:rounded-b-lg md:h-fit md:max-w-[640px] md:rounded-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-3.5 py-3 text-ink-3 md:py-2.5">
          <IconSearch className="h-4 w-4 shrink-0" />
          <input
            ref={inputRef}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKey}
            role="combobox"
            aria-expanded
            aria-controls={listboxId}
            aria-activedescendant={filtered.length > 0 ? `${listboxId}-${highlight}` : undefined}
            placeholder={placeholder}
            className="w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
          />
          <kbd className="rounded-sm border border-line-2 bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-2">
            esc
          </kbd>
        </div>
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          className="overflow-y-auto py-1 max-md:max-h-[65vh] md:max-h-[60vh]"
        >
          {grouped.length === 0 ? (
            <li className="px-4 py-8 text-center font-mono text-[12px] text-ink-2">No matches.</li>
          ) : (
            grouped.map((g) => (
              <li key={g.group} className="py-1">
                <div className="px-3.5 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-3">
                  {g.group}
                </div>
                <ul>
                  {g.items.map((c) => {
                    const idx = runningIdx++;
                    const focused = idx === highlight;
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          id={`${listboxId}-${idx}`}
                          data-idx={idx}
                          role="option"
                          aria-selected={focused}
                          onMouseEnter={() => setHighlight(idx)}
                          onClick={() => runAt(idx)}
                          className={cx(
                            "flex w-full items-center gap-3 px-3.5 py-2 text-left transition-colors max-md:min-h-[44px] md:py-2",
                            focused ? "bg-accent-wash text-accent" : "text-ink hover:bg-hover",
                          )}
                        >
                          {c.icon && (
                            <span
                              className={cx("shrink-0", focused ? "text-accent" : "text-ink-2")}
                            >
                              {c.icon}
                            </span>
                          )}
                          <span className="min-w-0 flex-1 truncate text-[13px]">{c.label}</span>
                          {c.secondary && (
                            <span
                              className={cx(
                                "shrink-0 truncate font-mono text-[11px]",
                                focused ? "text-accent/80" : "text-ink-3",
                              )}
                            >
                              {c.secondary}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))
          )}
        </ul>
        {hiddenSummary && (
          <div className="border-t border-line bg-surface px-3.5 py-1.5 font-mono text-[10.5px] text-ink-3">
            <span>Type to search </span>
            <span className="text-ink-2 tabular-nums">{hiddenSummary}</span>
          </div>
        )}
        <div className="flex items-center justify-between border-t border-line bg-surface px-3.5 py-1.5 font-mono text-[10px] text-ink-3">
          <span>
            <kbd className="rounded border border-line-2 bg-surface-2 px-1">↑</kbd>{" "}
            <kbd className="rounded border border-line-2 bg-surface-2 px-1">↓</kbd> navigate
          </span>
          <span>
            <kbd className="rounded border border-line-2 bg-surface-2 px-1">↵</kbd> select
          </span>
          <span>
            <kbd className="rounded border border-line-2 bg-surface-2 px-1">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
