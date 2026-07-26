import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { CellCtx, EditCtx } from "../types";
import { useAnchoredPopover } from "../useAnchoredPopover";

/* LinkedCell — FK picker cell that references another refTable's record records.
   Renderer resolves the stored key to a label via column.config.candidates.
   Editor is a searchable popover (no create — records are managed in their own table). */

function Renderer<Row>({ value, column }: CellCtx<Row>) {
  if (value == null || value === "") {
    return <span className="font-mono text-[12px] text-ink-2">—</span>;
  }
  const key = String(value);
  const candidates = column.config.type === "linked" ? column.config.candidates : [];
  const match = candidates.find((c) => c.key === key);
  return (
    <span className="truncate font-mono text-[12px] text-ink" title={match?.label ?? key}>
      {match?.label ?? key}
    </span>
  );
}

interface LinkedEditorProps<Row> extends EditCtx<Row> {
  candidates: { key: string; label: string }[];
  anchorRef: React.RefObject<HTMLDivElement | null>;
}

const POPOVER_WIDTH = 260;

function Editor<Row>({ value, commit, cancel, candidates, anchorRef }: LinkedEditorProps<Row>) {
  const [q, setQ] = useState("");
  const [hl, setHl] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useAnchoredPopover(popRef, anchorRef, POPOVER_WIDTH);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) cancel();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [cancel]);

  // Recompute only when the query or candidate set changes — not on every
  // keystroke-driven re-render (#157).
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return candidates;
    return candidates.filter(
      (c) => c.label.toLowerCase().includes(needle) || c.key.toLowerCase().includes(needle),
    );
  }, [q, candidates]);

  // Clamp the highlight when the filter narrows so it never points past the end
  // of `filtered` (a stale index would hide the highlight and could commit the
  // wrong row on Enter) (#157).
  useEffect(() => {
    setHl((h) => Math.min(h, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const listRef = useRef<HTMLDivElement>(null);
  const ROW = 30;
  const virtual = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW,
    overscan: 10,
  });
  // Keep the highlighted candidate scrolled into view during arrow-key nav.
  useEffect(() => {
    if (filtered.length > 0) virtual.scrollToIndex(hl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hl]);
  const vItems = virtual.getVirtualItems();
  const useVirtual = vItems.length > 0; // jsdom has no layout → render all rows

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      setHl((h) => Math.min(h + 1, filtered.length - 1));
      e.preventDefault();
    }
    if (e.key === "ArrowUp") {
      setHl((h) => Math.max(h - 1, 0));
      e.preventDefault();
    }
    if (e.key === "Enter") {
      if (filtered[hl]) commit(filtered[hl].key);
      e.preventDefault();
    }
    if (e.key === "Escape") cancel();
    if (e.key === "Backspace" && !q && value != null) commit(null);
  };

  return createPortal(
    <div
      ref={popRef}
      className="fixed z-50 overflow-hidden rounded-sm border border-line-2 bg-surface-elevated shadow-pop"
      style={{ width: POPOVER_WIDTH }}
    >
      <div className="border-b border-line px-2 py-1.5">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setHl(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search records…"
          className="w-full bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-ink-3"
        />
      </div>
      {value != null && value !== "" && (
        <button
          type="button"
          className="w-full px-3 py-1.5 text-left font-mono text-[11px] text-ink-3 hover:bg-hover"
          onMouseDown={(e) => {
            e.preventDefault();
            commit(null);
          }}
        >
          Clear
        </button>
      )}
      <div ref={listRef} className="max-h-48 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-2 font-mono text-[11px] text-ink-3">No records found</div>
        )}
        {/* Virtualized so a foreign-key column with thousands of records renders
            only the visible candidates, not the whole list per keystroke (#157).
            jsdom has no layout → fall back to rendering every row so tests see them. */}
        <div
          className="relative w-full"
          style={useVirtual ? { height: virtual.getTotalSize() } : undefined}
        >
          {(useVirtual
            ? vItems
            : filtered.map((_, i) => ({ index: i, start: i * ROW, key: i }))
          ).map((vi) => {
            const c = filtered[vi.index]!;
            const i = vi.index;
            return (
              <button
                key={c.key}
                type="button"
                className={`absolute left-0 top-0 w-full px-3 py-1.5 text-left transition-colors ${
                  i === hl ? "bg-accent-wash" : "hover:bg-hover"
                }`}
                style={
                  useVirtual ? { transform: `translateY(${vi.start}px)`, height: ROW } : undefined
                }
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(c.key);
                }}
                onMouseEnter={() => setHl(i)}
              >
                <span className="font-mono text-[12px] text-ink">{c.label}</span>
                <span className="ml-2 font-mono text-[10px] text-ink-3">{c.key}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export const LinkedCell = { Renderer, Editor };
