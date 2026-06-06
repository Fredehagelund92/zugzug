import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import { IconPlus, IconCheck, IconChevron, IconSearch } from "./Icons";
import { useEngineerMode } from "../lib/engineer-mode";
import type { MappingDimension } from "../data";
import type { PaletteName } from "../data";
import { PALETTE } from "../lib/palette";

/* TablePicker — a searchable switcher for the master-data table you're
   working in (+ create a new dim_* / map_* pair). Compact + type-to-find, so it
   scales from 3 to 300 dimensions without wrapping or blind scrolling. */

const DROPDOWN_W = 320;

function stats(d: MappingDimension) {
  const total = d.values.length;
  const mapped = d.values.filter((v) => v.current).length;
  const fresh = d.values.filter((v) => v.status === "new").length;
  return { total, fresh, pct: total ? Math.round((mapped / total) * 100) : 0 };
}

function Mono({
  label,
  active,
  color,
}: {
  label: string;
  active?: boolean;
  color?: PaletteName | null;
}) {
  if (color) {
    const tint = PALETTE[color];
    return (
      <div
        className="grid h-7 w-7 shrink-0 place-items-center rounded-sm font-display text-[13px] font-bold"
        style={{ background: active ? tint.bg : tint.wash, color: active ? "***REMOVED***FFFFFF" : tint.fg }}
      >
        {label.charAt(0).toUpperCase()}
      </div>
    );
  }
  // legacy / no color — rose accent like today
  return (
    <div
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-sm font-display text-[13px] font-bold ${active ? "bg-accent text-accent-ink" : "bg-accent-soft text-accent"}`}
    >
      {label.charAt(0).toUpperCase()}
    </div>
  );
}

export function TablePicker({
  dims,
  activeId,
  onSelect,
  onCreateRequested,
}: {
  dims: MappingDimension[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreateRequested: () => void;
}) {
  const { engineer } = useEngineerMode();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const dropdown = dropdownRef.current;
      const trigger = triggerRef.current;
      if (!dropdown || !trigger) return;
      const rect = trigger.getBoundingClientRect();
      const dropH = dropdown.offsetHeight;

      let left = rect.left;
      if (left + DROPDOWN_W > window.innerWidth - 8) left = window.innerWidth - DROPDOWN_W - 8;
      if (left < 8) left = 8;

      let top = rect.bottom + 6;
      if (top + dropH > window.innerHeight - 8) top = Math.max(8, rect.top - 6 - dropH);

      dropdown.style.left = `${left}px`;
      dropdown.style.top = `${top}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapperRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setQ("");
  };
  const active = dims.find((d) => d.id === activeId) ?? dims[0];
  const list = dims.filter((d) => d.dimension.toLowerCase().includes(q.toLowerCase().trim()));
  const choose = (id: string) => {
    onSelect(id);
    close();
  };

  const aStats = stats(active);

  return (
    <div ref={wrapperRef} className="relative inline-block">
      {/* trigger */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "flex min-w-[260px] items-center gap-2.5 rounded-md border bg-surface px-3 py-2 text-left transition-colors",
          open ? "border-accent" : "border-line-2 hover:border-accent",
        )}
      >
        <Mono label={active.dimension} active color={active.color} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-display text-[14px] font-semibold text-ink">
              {active.dimension}
            </span>
            {aStats.fresh > 0 && (
              <span className="shrink-0 rounded-pill bg-warn-soft px-1.5 font-mono text-[10px] text-warn">
                {aStats.fresh} new
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[10px] text-ink-3">
            {engineer
              ? active.mapTable
              : active.description
                ? active.description
                : `${aStats.total - aStats.fresh} mapped · ${aStats.fresh} new`}
          </div>
        </div>
        <IconChevron
          className={cx("h-4 w-4 shrink-0 text-ink-3 transition-transform", open && "rotate-180")}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{ position: "fixed", top: 0, left: 0, width: DROPDOWN_W }}
            className="zz-pop-in z-50 overflow-hidden rounded-md border border-line-2 bg-surface-elevated shadow-pop"
          >
            <div className="flex items-center gap-2 border-b border-line px-3 py-2.5 text-ink-3">
              <IconSearch className="h-3.5 w-3.5" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="find a table…"
                className="w-full bg-transparent font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3"
              />
            </div>
            <ul className="max-h-72 overflow-y-auto py-1">
              {list.map((d) => {
                const s = stats(d);
                const on = d.id === activeId;
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => choose(d.id)}
                      className={cx(
                        "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
                        on ? "bg-accent-wash" : "hover:bg-hover",
                      )}
                    >
                      <Mono label={d.dimension} active={on} color={d.color} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={cx(
                              "truncate font-display text-[13.5px] font-semibold",
                              on ? "text-accent" : "text-ink",
                            )}
                          >
                            {d.dimension}
                          </span>
                          {s.fresh > 0 && (
                            <span className="shrink-0 rounded-pill bg-warn-soft px-1.5 font-mono text-[10px] text-warn">
                              {s.fresh}
                            </span>
                          )}
                        </div>
                        <div className="truncate font-mono text-[10px] text-ink-3">
                          {engineer
                            ? d.mapTable
                            : d.description
                              ? d.description
                              : `${s.total - s.fresh} mapped · ${s.fresh} new`}
                        </div>
                      </div>
                      <span className="shrink-0 font-mono text-[10px] text-ink-3 tabular-nums">
                        {s.total ? `${s.pct}%` : "empty"}
                      </span>
                      {on && <IconCheck className="h-4 w-4 shrink-0 text-accent" />}
                    </button>
                  </li>
                );
              })}
              {list.length === 0 && (
                <li className="px-3 py-3 font-mono text-[12px] text-ink-3">no match</li>
              )}
            </ul>
            <button
              type="button"
              onClick={() => {
                close();
                onCreateRequested();
              }}
              className="flex w-full items-center gap-2 border-t border-line px-3 py-2.5 font-mono text-[12px] text-accent transition-colors hover:bg-accent-wash"
            >
              <IconPlus className="h-4 w-4" /> New table
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
