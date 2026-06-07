import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/cx";
import type { ConditionalRule, ColumnDef, RuleStyle } from "./types";
import type { PaletteName } from "../../lib/palette";
import { PALETTE_NAMES } from "../../lib/palette";

// Use all available palette names for the stripe picker
const PALETTES: PaletteName[] = PALETTE_NAMES;

const MENU_WIDTH = 440;
const GAP = 4;

export function ConditionalFormatPopover<Row>({
  column,
  rules,
  onChange,
  onClose,
  anchorRef,
}: {
  column: ColumnDef<Row>;
  rules: ConditionalRule[];
  onChange: (rules: ConditionalRule[]) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [local, setLocal] = useState<ConditionalRule[]>(rules);
  const numeric = column.config.type === "number" || column.config.type === "rating";

  useLayoutEffect(() => {
    const popover = ref.current;
    const anchor = anchorRef.current;
    if (!popover || !anchor) return;
    const place = (): void => {
      const a = anchor.getBoundingClientRect();
      const popH = popover.offsetHeight;
      let left = a.right - MENU_WIDTH;
      if (left < 8) left = 8;
      if (left + MENU_WIDTH > window.innerWidth - 8) left = window.innerWidth - MENU_WIDTH - 8;
      let top = a.bottom + GAP;
      if (top + popH > window.innerHeight - 8) top = Math.max(8, a.top - GAP - popH);
      popover.style.top = `${top}px`;
      popover.style.left = `${left}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchorRef, local.length]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const popover = ref.current;
      const anchor = anchorRef.current;
      const target = e.target as Node;
      if (popover && popover.contains(target)) return;
      if (anchor && anchor.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose, anchorRef]);

  const addRule = () => {
    const r: ConditionalRule = numeric
      ? {
          id: `r_${Date.now()}`,
          field: column.field,
          trigger: { kind: "gt", value: 0 },
          style: { rowStripe: "rose" },
        }
      : {
          id: `r_${Date.now()}`,
          field: column.field,
          trigger: { kind: "equals", value: "" },
          style: { rowStripe: "rose" },
        };
    setLocal((cur) => [...cur, r]);
  };

  const removeRule = (id: string) => setLocal((cur) => cur.filter((r) => r.id !== id));

  const save = () => {
    onChange(local);
    onClose();
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Conditional formatting"
      style={{ position: "fixed", top: 0, left: 0, width: MENU_WIDTH }}
      className="zz-pop-in z-50 rounded-lg border border-line-2 bg-surface-elevated p-3 shadow-pop"
    >
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
        Rules for {column.label}
      </div>
      <ul className="space-y-2">
        {local.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-1 rounded border border-line bg-surface p-2 text-[11px] font-mono"
          >
            <span className="text-ink-3">If</span>
            <select
              value={r.trigger.kind}
              onChange={(e) => {
                const k = e.target.value;
                setLocal((cur) =>
                  cur.map((x) =>
                    x.id === r.id
                      ? ({ ...x, trigger: defaultTrigger(k, numeric) } as ConditionalRule)
                      : x,
                  ),
                );
              }}
              className="rounded-sm border border-line bg-surface px-1 py-0.5 text-ink outline-none focus:border-accent"
            >
              {(numeric
                ? (["gt", "lt", "between", "is_empty", "is_not_empty"] as const)
                : ([
                    "equals",
                    "not_equals",
                    "contains",
                    "starts_with",
                    "ends_with",
                    "is_in",
                    "is_empty",
                    "is_not_empty",
                  ] as const)
              ).map((k) => (
                <option key={k} value={k}>
                  {labelFor(k)}
                </option>
              ))}
            </select>
            <TriggerInput
              rule={r}
              onChange={(t) =>
                setLocal((cur) =>
                  cur.map((x) => (x.id === r.id ? ({ ...x, trigger: t } as ConditionalRule) : x)),
                )
              }
            />
            <span className="text-ink-3">then</span>
            <StyleSwatchPicker
              style={r.style}
              onChange={(s) =>
                setLocal((cur) => cur.map((x) => (x.id === r.id ? { ...x, style: s } : x)))
              }
            />
            <button
              type="button"
              onClick={() => removeRule(r.id)}
              className="ml-auto text-ink-3 hover:text-danger"
              aria-label="Remove rule"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {local.length === 0 && (
        <p className="py-2 text-center font-mono text-[11px] text-ink-3">No rules yet.</p>
      )}
      <div className="mt-2 flex items-center justify-between">
        <button
          type="button"
          onClick={addRule}
          className="font-mono text-[11px] text-accent hover:brightness-110"
        >
          + Add rule
        </button>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm px-2 py-1 font-mono text-[11px] text-ink-2 hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            className="rounded-sm bg-accent px-2 py-1 font-mono text-[11px] text-accent-ink hover:brightness-110"
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function defaultTrigger(kind: string, _numeric: boolean): ConditionalRule["trigger"] {
  switch (kind) {
    case "is_empty":
      return { kind: "is_empty" };
    case "is_not_empty":
      return { kind: "is_not_empty" };
    case "gt":
      return { kind: "gt", value: 0 };
    case "lt":
      return { kind: "lt", value: 0 };
    case "between":
      return { kind: "between", min: 0, max: 0 };
    case "is_in":
      return { kind: "is_in", values: [] };
    default:
      return { kind: kind as "equals", value: "" };
  }
}

function labelFor(k: string): string {
  return (
    (
      {
        equals: "equals",
        not_equals: "≠",
        contains: "contains",
        starts_with: "starts with",
        ends_with: "ends with",
        is_empty: "is empty",
        is_not_empty: "is not empty",
        gt: ">",
        lt: "<",
        between: "between",
        is_in: "is one of",
      } as Record<string, string>
    )[k] ?? k
  );
}

function TriggerInput({
  rule,
  onChange,
}: {
  rule: ConditionalRule;
  onChange: (t: ConditionalRule["trigger"]) => void;
}) {
  const t = rule.trigger;
  if (t.kind === "is_empty" || t.kind === "is_not_empty") return null;
  const inputCls =
    "rounded-sm border border-line bg-surface px-1 py-0.5 font-mono text-[11px] text-ink outline-none focus:border-accent";
  if (t.kind === "between") {
    return (
      <>
        <input
          type="number"
          value={t.min}
          onChange={(e) => onChange({ ...t, min: Number(e.target.value) })}
          className={cx(inputCls, "w-16")}
        />
        <span className="text-ink-3">and</span>
        <input
          type="number"
          value={t.max}
          onChange={(e) => onChange({ ...t, max: Number(e.target.value) })}
          className={cx(inputCls, "w-16")}
        />
      </>
    );
  }
  if (t.kind === "gt" || t.kind === "lt") {
    return (
      <input
        type="number"
        value={t.value}
        onChange={(e) => onChange({ ...t, value: Number(e.target.value) })}
        className={cx(inputCls, "w-20")}
      />
    );
  }
  if (t.kind === "is_in") {
    return (
      <input
        type="text"
        placeholder="comma-separated"
        value={t.values.join(",")}
        onChange={(e) => onChange({ ...t, values: e.target.value.split(",").map((s) => s.trim()) })}
        className={cx(inputCls, "w-40")}
      />
    );
  }
  // Remaining cases all have a string `value` field
  const strTrigger = t as {
    kind: "equals" | "not_equals" | "contains" | "starts_with" | "ends_with";
    value: string;
  };
  return (
    <input
      type="text"
      value={strTrigger.value}
      onChange={(e) => onChange({ ...strTrigger, value: e.target.value })}
      className={cx(inputCls, "w-32")}
    />
  );
}

function StyleSwatchPicker({
  style,
  onChange,
}: {
  style: RuleStyle;
  onChange: (s: RuleStyle) => void;
}) {
  return (
    <div className="flex gap-0.5">
      {PALETTES.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange({ ...style, rowStripe: p })}
          aria-label={`Set stripe ${p}`}
          title={p}
          className={cx(
            "h-4 w-4 rounded-sm border transition-all",
            style.rowStripe === p ? "ring-2 ring-accent border-transparent" : "border-line",
          )}
          style={{ background: `var(--tint-${p})` }}
        />
      ))}
    </div>
  );
}
