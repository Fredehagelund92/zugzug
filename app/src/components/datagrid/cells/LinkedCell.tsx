import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CellCtx, EditCtx } from "../types";

/* LinkedCell — FK picker cell that references another dimension's record records.
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

  useLayoutEffect(() => {
    const pop = popRef.current;
    const anchor = anchorRef.current;
    if (!pop || !anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const popH = pop.offsetHeight;
      let left = a.left;
      if (left + POPOVER_WIDTH > window.innerWidth - 8)
        left = window.innerWidth - POPOVER_WIDTH - 8;
      let top = a.bottom + 2;
      if (top + popH > window.innerHeight - 8) top = Math.max(8, a.top - 2 - popH);
      pop.style.top = `${top}px`;
      pop.style.left = `${left}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) cancel();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [cancel]);

  const filtered = q.trim()
    ? candidates.filter(
        (c) =>
          c.label.toLowerCase().includes(q.toLowerCase()) ||
          c.key.toLowerCase().includes(q.toLowerCase()),
      )
    : candidates;

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
      <div className="max-h-48 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-2 font-mono text-[11px] text-ink-3">No records found</div>
        )}
        {filtered.map((c, i) => (
          <button
            key={c.key}
            type="button"
            className={`w-full px-3 py-1.5 text-left transition-colors ${
              i === hl ? "bg-accent-wash" : "hover:bg-hover"
            }`}
            onMouseDown={(e) => {
              e.preventDefault();
              commit(c.key);
            }}
            onMouseEnter={() => setHl(i)}
          >
            <span className="font-mono text-[12px] text-ink">{c.label}</span>
            <span className="ml-2 font-mono text-[10px] text-ink-3">{c.key}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

export const LinkedCell = { Renderer, Editor };
