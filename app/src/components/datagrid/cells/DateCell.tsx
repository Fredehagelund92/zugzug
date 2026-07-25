import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CellCtx, EditCtx } from "../types";
import { useAnchoredPopover } from "../useAnchoredPopover";

/* DateCell — typed YYYY-MM-DD input + custom calendar popover.

   We avoid <input type="date"> because it renders a wheel picker on iOS
   (unusable in a grid) and a browser-styled popup on desktop. The custom
   popover mirrors the SelectCell anchoring pattern (portal + fixed coords,
   scroll/resize re-position).

   Storage format is ISO YYYY-MM-DD. Dates are constructed at noon local time
   to avoid DST/timezone edge cases shifting the displayed day. */

const inputBase =
  "w-full h-full bg-transparent border-0 outline-none p-0 m-0 font-mono text-[12px] leading-normal text-ink";

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseISO(s: string): Date | null {
  const m = ISO_RE.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d, 12, 0, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sameYMD(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function Renderer<Row>({ value }: CellCtx<Row>) {
  const s = value == null || value === "" ? null : String(value);
  return s ? (
    <span className="truncate font-mono text-[12px] text-ink" title={s}>
      {s}
    </span>
  ) : (
    <span className="font-mono text-[12px] text-ink-2">—</span>
  );
}

interface DateEditorProps<Row> extends EditCtx<Row> {
  anchorRef: React.RefObject<HTMLDivElement | null>;
}

const POPOVER_WIDTH = 232;

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function monthDays(year: number, month: number): Date[] {
  // 6 weeks (42 cells) starting on the Sunday on/before the 1st.
  const first = new Date(year, month, 1, 12, 0, 0, 0);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d);
  }
  return days;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function Editor<Row>({ value, initial, commit, cancel, anchorRef }: DateEditorProps<Row>) {
  const seeded = initial != null;
  const [v, setV] = useState(seeded ? initial : value == null ? "" : String(value));
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);

  const parsedV = useMemo(() => parseISO(v), [v]);
  const today = useMemo(() => {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), t.getDate(), 12, 0, 0, 0);
  }, []);

  // Calendar view anchor: the month being displayed.
  const [view, setView] = useState<{ y: number; m: number }>(() => {
    const base = parsedV ?? today;
    return { y: base.getFullYear(), m: base.getMonth() };
  });

  useEffect(() => {
    inputRef.current?.focus();
    if (seeded) {
      const el = inputRef.current;
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    } else {
      inputRef.current?.select();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Anchor the popover under the cell — scroll/resize aware (matches SelectCell).
  useAnchoredPopover(popRef, anchorRef, POPOVER_WIDTH);

  // Outside click closes (commits the typed value if valid, else cancels).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const pop = popRef.current;
      const anchor = anchorRef.current;
      const target = e.target as Node;
      if (pop?.contains(target)) return;
      if (anchor?.contains(target)) return;
      const t = v.trim();
      if (t === "") {
        commit(null);
        return;
      }
      const d = parseISO(t);
      if (d) commit(toISO(d));
      else cancel();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [v, commit, cancel, anchorRef]);

  const commitTyped = () => {
    const t = v.trim();
    if (t === "") {
      commit(null);
      return;
    }
    const d = parseISO(t);
    if (d) commit(toISO(d));
    else cancel();
  };

  const days = useMemo(() => monthDays(view.y, view.m), [view]);

  const prevMonth = () => {
    setView((s) => (s.m === 0 ? { y: s.y - 1, m: 11 } : { y: s.y, m: s.m - 1 }));
  };
  const nextMonth = () => {
    setView((s) => (s.m === 11 ? { y: s.y + 1, m: 0 } : { y: s.y, m: s.m + 1 }));
  };

  return (
    <>
      <input
        ref={inputRef}
        value={v}
        placeholder="YYYY-MM-DD"
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          // Defer so a click on a calendar day fires before blur commits.
          // The portal click handlers commit directly; if focus is lost for
          // any other reason, commit the typed value.
          window.setTimeout(() => {
            if (!popRef.current) return;
            if (popRef.current.contains(document.activeElement)) return;
            commitTyped();
          }, 0);
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || composingRef.current) return;
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
            return;
          }
          if (e.key === "Enter" || e.key === "Tab") {
            commitTyped();
          }
        }}
        className={inputBase}
      />
      {createPortal(
        <div
          ref={popRef}
          style={{ position: "fixed", top: 0, left: 0, width: POPOVER_WIDTH }}
          className="z-50 rounded-sm border border-line-2 bg-surface-elevated p-2 shadow-pop"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                prevMonth();
              }}
              className="rounded-sm px-1.5 py-0.5 font-mono text-[12px] text-ink-2 hover:bg-hover"
              aria-label="Previous month"
            >
              ‹
            </button>
            <span className="font-mono text-[11.5px] text-ink">
              {MONTH_NAMES[view.m]} {view.y}
            </span>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                nextMonth();
              }}
              className="rounded-sm px-1.5 py-0.5 font-mono text-[12px] text-ink-2 hover:bg-hover"
              aria-label="Next month"
            >
              ›
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {WEEKDAYS.map((w) => (
              <div key={w} className="py-0.5 text-center font-mono text-[10px] text-ink-3">
                {w}
              </div>
            ))}
            {days.map((d) => {
              const inMonth = d.getMonth() === view.m;
              const isToday = sameYMD(d, today);
              const isSelected = parsedV ? sameYMD(d, parsedV) : false;
              const cls = [
                "h-6 rounded-sm font-mono text-[11px] tabular-nums",
                inMonth ? "text-ink" : "text-ink-3",
                isSelected
                  ? "bg-accent text-white"
                  : isToday
                    ? "ring-1 ring-accent ring-inset"
                    : "hover:bg-hover",
              ].join(" ");
              return (
                <button
                  key={toISO(d)}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(toISO(d));
                  }}
                  className={cls}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex justify-between border-t border-line pt-1.5">
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                commit(toISO(today));
              }}
              className="rounded-sm px-1.5 py-0.5 font-mono text-[10.5px] text-accent hover:bg-accent-wash"
            >
              Today
            </button>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                commit(null);
              }}
              className="rounded-sm px-1.5 py-0.5 font-mono text-[10.5px] text-ink-3 hover:bg-hover"
            >
              Clear
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

export const DateCell = { Renderer, Editor };
