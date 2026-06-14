import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Aggregates } from "./useAggregates";

const AGG_KEYS = ["count", "distinct", "sum", "avg", "min", "max"] as const;
type AggKey = (typeof AGG_KEYS)[number];

const STORAGE_KEY = "zz.grid.statusBar.aggregates";
const DEFAULT_VISIBLE: AggKey[] = ["count", "distinct", "sum", "avg"];

function loadVisible(): AggKey[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_VISIBLE;
    const parsed = JSON.parse(raw) as string[];
    return parsed.filter((k): k is AggKey => (AGG_KEYS as readonly string[]).includes(k));
  } catch {
    return DEFAULT_VISIBLE;
  }
}

function saveVisible(v: AggKey[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

function fmt(v: number | string | null): string {
  if (v == null) return "—";
  if (typeof v === "number") return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return v;
}

const LABEL: Record<AggKey, string> = {
  count: "Count",
  distinct: "Distinct",
  sum: "Sum",
  avg: "Avg",
  min: "Min",
  max: "Max",
};

export function StatusBar({ agg }: { agg: Aggregates | null }) {
  const [visible, setVisible] = useState<AggKey[]>(loadVisible);
  const [open, setOpen] = useState(false);
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({});
  const barRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveVisible(visible);
  }, [visible]);

  useEffect(() => {
    if (!open || !barRef.current) return;
    const rect = barRef.current.getBoundingClientRect();
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    // prefer above, fall back to below if not enough room
    const above = spaceAbove >= 200 || spaceAbove >= spaceBelow;
    if (above) {
      setPopupStyle({
        position: "fixed",
        bottom: window.innerHeight - rect.top + 4,
        right: window.innerWidth - rect.right,
        maxHeight: Math.max(spaceAbove - 8, 100),
        overflowY: "auto",
        zIndex: 9999,
      });
    } else {
      setPopupStyle({
        position: "fixed",
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
        maxHeight: Math.max(spaceBelow - 8, 100),
        overflowY: "auto",
        zIndex: 9999,
      });
    }
    const handler = (e: MouseEvent) => {
      if (
        popupRef.current &&
        !popupRef.current.contains(e.target as Node) &&
        barRef.current &&
        !barRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const toggle = (k: AggKey) => {
    setVisible((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  };

  return (
    <div
      ref={barRef}
      className="flex items-center justify-end gap-4 border-t border-line bg-surface px-3 py-1 font-mono text-[11px] text-ink-2 tabular-nums min-h-[26px]"
      onClick={() => setOpen((s) => !s)}
      role="status"
      aria-label="Selection aggregates"
    >
      {agg &&
        visible.map((k) => {
          const value = agg[k];
          return (
            <span key={k} title={LABEL[k]}>
              <span className="text-ink-3">{LABEL[k]}:</span>{" "}
              <span className="text-ink">{fmt(value as number | string | null)}</span>
            </span>
          );
        })}
      {open &&
        createPortal(
          <div
            ref={popupRef}
            onClick={(e) => e.stopPropagation()}
            style={popupStyle}
            className="rounded-lg border border-line bg-surface-elevated p-2 shadow-pop"
          >
            {AGG_KEYS.map((k) => (
              <label
                key={k}
                className="flex items-center gap-2 px-2 py-1 text-[12px] text-ink hover:bg-hover rounded cursor-pointer"
              >
                <input type="checkbox" checked={visible.includes(k)} onChange={() => toggle(k)} />
                {LABEL[k]}
              </label>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
