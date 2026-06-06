import { useEffect, useRef, useState } from "react";
import type { CellCtx, EditCtx } from "../types";
import type { NumberFormat } from "../../../data";

const inputBase =
  "w-full rounded-sm border border-accent bg-bg px-1.5 py-0.5 text-right font-mono text-[12px] text-ink outline-none tabular-nums";

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
  }
}

function Renderer<Row>(ctx: CellCtx<Row>) {
  const { value, column } = ctx;
  const fmt = column.numberFormat;
  const n = value == null || value === "" ? null : Number(value);
  if (n == null || !Number.isFinite(n)) {
    return <span className="font-mono text-[12px] text-ink-3">—</span>;
  }
  return (
    <span className="text-right tabular-nums font-mono text-[12px] text-ink">
      {formatNumber(value, fmt)}
    </span>
  );
}

function Editor<Row>({ value, initial, commit, cancel, column }: EditCtx<Row>) {
  const fmt = column.numberFormat;
  const isPercent = fmt?.format === "percent";

  // For percent fields, display the value * 100 for editing (e.g. 0.42 → "42")
  const displayValue =
    isPercent && value != null && value !== "" && Number.isFinite(Number(value))
      ? String(Number(value) * 100)
      : value == null
        ? ""
        : String(value);

  const seeded = initial != null;
  const usable = seeded && /^[0-9.-]$/.test(initial);
  const [v, setV] = useState(usable ? initial : displayValue);
  const ref = useRef<HTMLInputElement>(null);

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
    const n = Number(t);
    if (!Number.isFinite(n)) {
      commit(null);
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
      onChange={(e) => setV(e.target.value)}
      onBlur={commitNow}
      onKeyDown={(e) => {
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
