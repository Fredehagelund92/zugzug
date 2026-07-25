import { useEffect, useRef, useState } from "react";
import type { CellCtx, EditCtx, ColumnDef } from "../types";
import type { NumberFormat } from "../../../data";

const inputBase =
  "w-full h-full bg-transparent border-0 outline-none p-0 m-0 text-right font-mono text-[12px] leading-normal text-ink tabular-nums";

export function formatNumber(value: unknown, fmt: NumberFormat | undefined): string {
  const n = value == null || value === "" ? null : Number(value);
  if (n == null || !Number.isFinite(n)) return "—";
  if (fmt == null) return String(n);

  switch (fmt.format) {
    case "integer":
      return n.toLocaleString("en-US", { maximumFractionDigits: 0 });

    case "decimal":
      return n.toLocaleString("en-US", {
        minimumFractionDigits: fmt.precision,
        maximumFractionDigits: fmt.precision,
      });

    case "percent": {
      const pct = n * 100;
      return (
        pct.toLocaleString("en-US", {
          minimumFractionDigits: fmt.precision,
          maximumFractionDigits: fmt.precision,
        }) + "%"
      );
    }

    case "currency": {
      const abs = Math.abs(n);
      const formatted = abs.toLocaleString("en-US", {
        minimumFractionDigits: fmt.precision,
        maximumFractionDigits: fmt.precision,
      });
      const sign = n < 0 ? "-" : "";
      if (fmt.position === "prefix") return `${sign}${fmt.symbol}${formatted}`;
      return `${sign}${formatted} ${fmt.symbol}`;
    }

    case "compact":
      return n.toLocaleString("en-US", {
        notation: "compact",
        minimumFractionDigits: fmt.precision,
        maximumFractionDigits: fmt.precision,
      } as Intl.NumberFormatOptions);

    case "duration": {
      const totalSec = Math.round(Math.abs(n));
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      const sign = n < 0 ? "-" : "";
      if (fmt.display === "hms") {
        return `${sign}${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      }
      // hm: human-readable "Xh Ym" or "Ym" or "< 1m"
      if (totalSec < 60) return "< 1m";
      if (h > 0) return `${sign}${h}h ${m}m`;
      return `${sign}${m}m`;
    }
  }
}

function getNumberFormat<Row>(column: ColumnDef<Row>): NumberFormat | undefined {
  return column.config.type === "number" ? column.config.numberFormat : undefined;
}

function secondsToHms(n: number): string {
  const secs = Math.round(Math.abs(n));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function hmsToSeconds(v: string): number | null {
  const match = v.trim().match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const h = parseInt(match[1]!, 10);
  const m = parseInt(match[2]!, 10);
  const s = parseInt(match[3]!, 10);
  if (m >= 60 || s >= 60) return null;
  return h * 3600 + m * 60 + s;
}

function Renderer<Row>(ctx: CellCtx<Row>) {
  const { value, column } = ctx;
  const fmt = getNumberFormat(column);
  const n = value == null || value === "" ? null : Number(value);
  if (n == null || !Number.isFinite(n)) {
    return <span className="font-mono text-[12px] text-ink-3">—</span>;
  }
  return (
    <span
      className="block w-full truncate text-right tabular-nums font-mono text-[12px] text-ink"
      title={formatNumber(n, fmt)}
    >
      {formatNumber(n, fmt)}
    </span>
  );
}

function Editor<Row>({ value, initial, commit, cancel, column }: EditCtx<Row>) {
  const fmt = getNumberFormat(column);
  const isPercent = fmt?.format === "percent";
  const isDuration = fmt?.format === "duration";

  // Compute display value based on format
  const displayValue = (() => {
    if (isDuration && value != null && value !== "" && Number.isFinite(Number(value))) {
      return secondsToHms(Number(value));
    }
    if (isPercent && value != null && value !== "" && Number.isFinite(Number(value))) {
      return String(parseFloat((Number(value) * 100).toPrecision(10)));
    }
    return value == null ? "" : String(value);
  })();

  const seeded = initial != null;
  // Type-to-edit with a non-numeric character is ignored — leave the cell
  // alone so the keystroke doesn't accidentally clear a numeric value.
  const usable = seeded && /^[0-9.-]$/.test(initial);
  const [v, setV] = useState(usable ? initial : displayValue);
  const ref = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    if (usable) {
      const el = ref.current;
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    } else {
      ref.current?.select();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const commitNow = () => {
    const t = v.trim();
    if (t === "") {
      commit(null);
      return;
    }
    if (isDuration) {
      const secs = hmsToSeconds(t);
      if (secs == null) {
        cancel();
        return;
      }
      commit(secs);
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n)) {
      cancel();
      return;
    }
    // Percent editor works in display space (0–100); store normalized (0–1)
    commit(isPercent ? n / 100 : n);
  };

  return (
    <input
      ref={ref}
      value={v}
      inputMode="decimal"
      placeholder={isDuration ? "0:00:00" : undefined}
      onChange={(e) => setV(e.target.value)}
      onBlur={commitNow}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
      }}
      // Enter / Tab also commit synchronously: useGridCursor's stopEdit
      // unmounts the editor before the browser blur event reaches React, so
      // relying on onBlur alone silently drops the typed value.
      onKeyDown={(e) => {
        // IME composition (CJK): Enter/Tab mean "accept candidate", not
        // "commit cell".
        if (e.nativeEvent.isComposing || composingRef.current) return;
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") commitNow();
      }}
      className={inputBase}
    />
  );
}

export const NumberCell = { Renderer, Editor };
