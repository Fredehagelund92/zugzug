import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import { bindOverlayScroll } from "../lib/overlay-scroll";
import { Button } from "./Button";
import { OptionBuilder } from "./OptionBuilder";
import { toast } from "./Toast";
import type { NumberFormat, OptionDef } from "../data";
import type { ColumnConfig } from "./datagrid/types";
import { ValidationFields } from "./datagrid/ValidationFields";
import { FormulaEditor, type FormulaCheck } from "./FormulaEditor";

export type { FormulaCheck };

/** A computed field: the expression + declared output type. Emitted alongside
 *  `config` (set to the output type) so the host can render it read-only. */
export interface FormulaInput {
  expr: string;
  resultType: "text" | "number" | "boolean";
  numberFormat?: NumberFormat;
}

export interface AddFieldInput {
  label: string;
  config: ColumnConfig;
  formula?: FormulaInput;
}

interface AddFieldPopoverProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSubmit: (input: AddFieldInput) => Promise<void>;
  allDims?: { id: string; refTable: string }[];
  currentRefTableId?: string;
  /** Existing field labels a formula may reference (click-to-insert). */
  availableFields?: { field: string; label: string }[];
  /** Dry-run a formula against a sample record for live feedback. */
  onValidateFormula?: (expr: string) => Promise<FormulaCheck>;
}

// "formula" isn't a ColumnConfig type (it renders as its result type); it's a
// synthetic tile that reveals the expression editor.
type FieldType = ColumnConfig["type"] | "formula";

interface TypeTile {
  type: FieldType;
  icon: string;
  label: string;
}

const TYPE_TILES: TypeTile[] = [
  { type: "text", icon: "A", label: "Text" },
  { type: "number", icon: "#", label: "Number" },
  { type: "boolean", icon: "☑", label: "Checkbox" },
  { type: "date", icon: "⊞", label: "Date" },
  { type: "select", icon: "◉", label: "Select" },
  { type: "url", icon: "↗", label: "URL" },
  { type: "email", icon: "@", label: "Email" },
  { type: "rating", icon: "★", label: "Rating" },
  { type: "linked", icon: "⇢", label: "Linked" },
  { type: "formula", icon: "ƒ", label: "Formula" },
];

export function AddFieldPopover({
  anchorRef,
  onClose,
  onSubmit,
  allDims,
  currentRefTableId,
  availableFields,
  onValidateFormula,
}: AddFieldPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  // Read through a ref so an inline `onClose` from the host doesn't re-bind
  // (and re-place) the popover on every keystroke in the name field.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [options, setOptions] = useState<OptionDef[]>([]);
  const [createAnother, setCreateAnother] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [numFmt, setNumFmt] = useState<
    "integer" | "decimal" | "percent" | "currency" | "compact" | "duration"
  >("integer");
  const [numPrecision, setNumPrecision] = useState<number>(2);
  const [currSymbol, setCurrSymbol] = useState("$");
  const [currPosition, setCurrPosition] = useState<"prefix" | "suffix">("prefix");
  const [ratingMax, setRatingMax] = useState<number>(5);
  const [ratingMaxCustom, setRatingMaxCustom] = useState("");
  const [durationDisplay, setDurationDisplay] = useState<"hm" | "hms">("hm");
  const [linkedTargetRefTableId, setLinkedTargetRefTableId] = useState<string>("");
  const [required, setRequired] = useState(false);
  const [unique, setUnique] = useState(false);
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [formulaExpr, setFormulaExpr] = useState("");
  const [formulaResultType, setFormulaResultType] = useState<"text" | "number" | "boolean">("text");
  const [formulaCheck, setFormulaCheck] = useState<FormulaCheck | null>(null);
  // Airtable-style positioning: the popover's RIGHT edge aligns with the
  // "+ field" button's right edge, so the popover drops below the button and
  // extends LEFTWARD into the grid (where there's room — the button sits at
  // the right edge of the column headers, so growing rightward would clamp
  // against the viewport and read as "stuck in the corner").
  //
  // On mobile (<768px) the popover fills the viewport width with horizontal
  // inset-4 margins, centered, instead of anchoring to the small trigger.
  //
  // The popover is rendered in a portal on document.body and positioned with
  // `position: fixed`, so coordinates are viewport-relative — getBoundingClientRect
  // already returns viewport coords. NO scrollY math; the portal escapes any
  // ancestor `transform`/`contain` style that would otherwise create a
  // containing block for the fixed element.
  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;

    const POPOVER_WIDTH = 320;
    const GAP = 6;

    const place = (): void => {
      const anchor = anchorRef.current;
      if (!anchor) return;

      if (window.innerWidth < 768) {
        const margin = 16;
        popover.style.left = `${margin}px`;
        popover.style.top = `${margin * 4}px`;
        popover.style.width = `${window.innerWidth - margin * 2}px`;
        return;
      }

      popover.style.width = `${POPOVER_WIDTH}px`;
      const rect = anchor.getBoundingClientRect();
      const popH = popover.offsetHeight;

      // right-edge of popover aligns with right-edge of "+ field" button
      let left = rect.right - POPOVER_WIDTH;
      if (left < 8) left = 8; // clamp to viewport left if needed
      if (left + POPOVER_WIDTH > window.innerWidth - 8)
        left = window.innerWidth - POPOVER_WIDTH - 8;

      // place below the button; flip above if it would overflow the viewport
      let top = rect.bottom + GAP;
      if (top + popH > window.innerHeight - 8) top = Math.max(8, rect.top - GAP - popH);

      popover.style.top = `${top}px`;
      popover.style.left = `${left}px`;
    };

    place();
    // A page scroll closes the popover rather than dragging it across the
    // screen (#197). This one holds a typed field name and its config, so the
    // dismissal deliberately calls the *same* `onClose` the existing
    // outside-click handler (below) already calls — a pointerdown outside
    // discards the draft today, so scrolling away discards it too. No new
    // loss path. The popover's own body is a scroller (max-h/overflow-y), and
    // the inside guard keeps scrolling it from closing it.
    return bindOverlayScroll({
      pop: popover,
      anchor: anchorRef.current,
      place,
      onDismiss: () => closeRef.current(),
    });
  }, [anchorRef]);

  // Focus name input on mount
  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void handleSubmit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    label,
    type,
    options,
    createAnother,
    numFmt,
    numPrecision,
    currSymbol,
    currPosition,
    ratingMax,
    durationDisplay,
    linkedTargetRefTableId,
  ]);

  // Focus trap
  useEffect(() => {
    const root = popoverRef.current;
    if (!root) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  }, []);

  // Close on click-outside
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popoverRef.current && !popoverRef.current.contains(target)) {
        // Don't close if clicking the anchor button itself (host toggles)
        if (anchorRef.current && anchorRef.current.contains(target)) return;
        onClose();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [anchorRef, onClose]);

  const resetForm = () => {
    setLabel("");
    setType("text");
    setFormulaExpr("");
    setFormulaResultType("text");
    setFormulaCheck(null);
    setOptions([]);
    setNumFmt("integer");
    setNumPrecision(2);
    setCurrSymbol("$");
    setCurrPosition("prefix");
    setRatingMax(5);
    setRatingMaxCustom("");
    setDurationDisplay("hm");
    setLinkedTargetRefTableId("");
    setRequired(false);
    setUnique(false);
    setMin("");
    setMax("");
    setError(null);
    nameInputRef.current?.focus();
  };

  const handleSubmit = () => {
    const trimmed = label.trim();
    if (!trimmed) return;
    if (type === "linked" && !linkedTargetRefTableId) {
      setError("Pick the table this field links to.");
      return;
    }
    if (type === "formula") {
      if (!formulaExpr.trim()) {
        setError("Enter a formula.");
        return;
      }
      if (formulaCheck && !formulaCheck.ok) {
        setError(formulaCheck.error ?? "This formula isn't valid.");
        return;
      }
    }
    setError(null);

    let config: ColumnConfig;
    if (type === "number") {
      let numberFormat: NumberFormat | undefined;
      if (numFmt === "integer") {
        numberFormat = { format: "integer" };
      } else if (numFmt === "decimal") {
        numberFormat = { format: "decimal", precision: numPrecision as 1 | 2 | 3 | 4 };
      } else if (numFmt === "percent") {
        numberFormat = { format: "percent", precision: numPrecision as 0 | 1 | 2 };
      } else if (numFmt === "compact") {
        numberFormat = { format: "compact", precision: numPrecision as 0 | 1 | 2 };
      } else if (numFmt === "duration") {
        numberFormat = { format: "duration", display: durationDisplay };
      } else {
        numberFormat = {
          format: "currency",
          symbol: currSymbol || "$",
          position: currPosition,
          precision: numPrecision as 0 | 1 | 2,
        };
      }
      config = { type: "number", numberFormat };
    } else if (type === "select") {
      config = { type: "select", options };
    } else if (type === "rating") {
      config = { type: "rating", ratingMax };
    } else if (type === "linked") {
      config = {
        type: "linked",
        targetRefTableId: linkedTargetRefTableId,
        displayFields: ["label"],
        candidates: [],
      };
    } else if (type === "formula") {
      config =
        formulaResultType === "number"
          ? { type: "number" }
          : formulaResultType === "boolean"
            ? { type: "boolean" }
            : { type: "text" };
    } else {
      config = { type } as ColumnConfig;
    }

    let formula: FormulaInput | undefined;
    if (type === "formula") {
      formula = { expr: formulaExpr.trim(), resultType: formulaResultType };
    } else {
      config.required = required;
      const num = (s: string) => {
        if (s.trim() === "") return undefined;
        if (type === "date") return s.trim();
        const n = Number(s);
        if (type === "text") return Math.max(0, Math.floor(n));
        return n;
      };
      const validationObj: NonNullable<typeof config.validation> = {};
      if (unique) validationObj.unique = true;
      if (num(min) !== undefined) validationObj.min = num(min)!;
      if (num(max) !== undefined) validationObj.max = num(max)!;
      if (Object.keys(validationObj).length > 0) config.validation = validationObj;
    }

    const input: AddFieldInput = { label: trimmed, config, formula };

    // Close/reset immediately — provision in the background.
    if (createAnother) {
      resetForm();
    } else {
      onClose();
    }

    const run = (i: AddFieldInput): void => {
      void onSubmit(i).then(
        () => {
          /* success — nothing extra to do */
        },
        (err) => {
          const msg = err instanceof Error ? err.message : "Something went wrong.";
          toast(`Failed to add field "${i.label}": ${msg}`, "error", {
            label: "Retry",
            onClick: () => run(i),
          });
        },
      );
    };
    run(input);
  };

  const canSubmit =
    label.trim().length > 0 && (type !== "formula" || formulaExpr.trim().length > 0);

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="true"
      aria-label="Add field"
      className="zz-pop-in fixed z-40 max-h-[90vh] overflow-y-auto rounded-sm border border-line-2 bg-surface-elevated shadow-pop"
    >
      {/* Accent top edge */}
      <div className="h-px w-full rounded-t-sm bg-gradient-to-r from-transparent via-accent/70 to-transparent" />

      <div className="p-4 space-y-4">
        {/* Eyebrow */}
        <div className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-3">
          Add field
        </div>

        {/* Name input */}
        <input
          ref={nameInputRef}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && type !== "select") handleSubmit();
          }}
          placeholder="Field name…"
          className="w-full rounded-sm border border-line-2 bg-bg px-3 py-2 font-display text-[16px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
        />

        {/* Type grid — 2 columns, 3 rows */}
        <div className="grid grid-cols-2 gap-1.5">
          {TYPE_TILES.map(({ type: t, icon, label: typeLabel }) => {
            const active = type === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={cx(
                  "flex items-center gap-2 rounded-sm border p-2 text-left transition-colors",
                  active
                    ? "border-accent bg-accent-wash"
                    : "border-line hover:border-line-2 hover:bg-hover",
                )}
              >
                <span
                  className={cx(
                    "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-sm font-mono text-[11px]",
                    active ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink-2",
                  )}
                  aria-hidden
                >
                  {icon}
                </span>
                <span className="font-mono text-[11px] text-ink">{typeLabel}</span>
              </button>
            );
          })}
        </div>

        {/* Type-specific config */}
        {type === "select" && (
          <>
            <div className="border-t border-line" />
            <OptionBuilder options={options} onChange={setOptions} />
          </>
        )}

        {/* Number format config */}
        {type === "number" && (
          <>
            <div className="border-t border-line" />
            <div className="space-y-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
                Format
              </div>

              {/* Format tiles */}
              <div className="grid grid-cols-2 gap-1.5">
                {(
                  [
                    { f: "integer", icon: "#", label: "Integer" },
                    { f: "decimal", icon: "#.0", label: "Decimal" },
                    { f: "percent", icon: "%", label: "Percent" },
                    { f: "currency", icon: "$", label: "Currency" },
                    { f: "compact", icon: "1.2M", label: "Compact" },
                    { f: "duration", icon: "⏱", label: "Duration" },
                  ] as const
                ).map(({ f, icon, label: fLabel }) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => {
                      setNumFmt(f);
                      // Reset precision to a valid value for the new format's range
                      setNumPrecision(f === "decimal" ? 2 : f === "integer" ? 2 : 0);
                    }}
                    className={cx(
                      "flex items-center gap-2 rounded-sm border p-2 text-left transition-colors",
                      numFmt === f
                        ? "border-accent bg-accent-wash"
                        : "border-line hover:border-line-2 hover:bg-hover",
                    )}
                  >
                    <span
                      className={cx(
                        "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-sm font-mono text-[10px]",
                        numFmt === f ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink-2",
                      )}
                      aria-hidden
                    >
                      {icon}
                    </span>
                    <span className="font-mono text-[11px] text-ink">{fLabel}</span>
                  </button>
                ))}
              </div>

              {/* Precision (decimal / percent / currency) */}
              {(numFmt === "decimal" || numFmt === "percent" || numFmt === "currency") && (
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-ink-3 w-16 shrink-0">Precision</span>
                  <div className="flex gap-1">
                    {(numFmt === "decimal" ? [1, 2, 3, 4] : [0, 1, 2]).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setNumPrecision(p)}
                        className={cx(
                          "h-6 w-6 rounded-sm border font-mono text-[11px] transition-colors",
                          numPrecision === p
                            ? "border-accent bg-accent-wash text-ink"
                            : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
                        )}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Compact precision picker */}
              {numFmt === "compact" && (
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[10px] text-ink-3 w-14">Precision</span>
                  {([0, 1, 2] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setNumPrecision(p)}
                      className={cx(
                        "h-6 w-6 rounded-sm border font-mono text-[11px] transition-colors",
                        numPrecision === p
                          ? "border-accent bg-accent-wash text-ink"
                          : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
                      )}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}

              {/* Duration display-mode toggle */}
              {numFmt === "duration" && (
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-ink-3 w-16 shrink-0">Display</span>
                  <div className="flex gap-1">
                    {(["hm", "hms"] as const).map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setDurationDisplay(d)}
                        className={cx(
                          "rounded-sm border px-2 py-0.5 font-mono text-[10px] transition-colors",
                          durationDisplay === d
                            ? "border-accent bg-accent-wash text-ink"
                            : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
                        )}
                      >
                        {d === "hm" ? "h m" : "h:mm:ss"}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Symbol + position (currency) */}
              {numFmt === "currency" && (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-1">
                    {["$", "€", "£", "¥", "kr", "USD", "EUR", "GBP"].map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setCurrSymbol(s)}
                        className={cx(
                          "rounded-sm border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                          currSymbol === s
                            ? "border-accent bg-accent-wash text-ink"
                            : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
                        )}
                      >
                        {s}
                      </button>
                    ))}
                    <input
                      value={currSymbol}
                      onChange={(e) => setCurrSymbol(e.target.value.slice(0, 6))}
                      placeholder="…"
                      className="w-12 rounded-sm border border-line-2 bg-bg px-1.5 py-0.5 font-mono text-[10px] text-ink outline-none focus:border-accent"
                    />
                  </div>
                  <div className="flex gap-1.5">
                    {(["prefix", "suffix"] as const).map((pos) => (
                      <button
                        key={pos}
                        type="button"
                        onClick={() => setCurrPosition(pos)}
                        className={cx(
                          "flex-1 rounded-sm border px-2 py-1.5 font-mono text-[10px] capitalize transition-colors",
                          currPosition === pos
                            ? "border-accent bg-accent-wash text-ink"
                            : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
                        )}
                      >
                        {pos === "prefix" ? "$ 42.00" : "42.00 $"}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* Rating max config */}
        {type === "rating" && (
          <>
            <div className="border-t border-line" />
            <div className="space-y-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
                Max stars
              </div>
              <div className="flex items-center gap-1.5">
                {[3, 5, 10].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => {
                      setRatingMax(n);
                      setRatingMaxCustom("");
                    }}
                    className={cx(
                      "h-7 w-8 rounded-sm border font-mono text-[11px] transition-colors",
                      ratingMax === n && !ratingMaxCustom
                        ? "border-accent bg-accent-wash text-ink"
                        : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
                    )}
                  >
                    {n}
                  </button>
                ))}
                <input
                  value={ratingMaxCustom}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") {
                      setRatingMaxCustom("");
                      return;
                    }
                    const n = parseInt(raw, 10);
                    if (Number.isInteger(n) && n >= 1 && n <= 20) {
                      setRatingMaxCustom(raw);
                      setRatingMax(n);
                    }
                  }}
                  placeholder="…"
                  className="w-12 rounded-sm border border-line-2 bg-bg px-1.5 py-0.5 font-mono text-[10px] text-ink outline-none focus:border-accent"
                />
              </div>
            </div>
          </>
        )}

        {type === "linked" && (
          <>
            <div className="border-t border-line" />
            <div className="space-y-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
                Link to table
              </div>
              <select
                value={linkedTargetRefTableId}
                onChange={(e) => setLinkedTargetRefTableId(e.target.value)}
                className="w-full rounded-sm border border-line-2 bg-bg px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-accent"
              >
                <option value="">— pick a table —</option>
                {(allDims ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.id === currentRefTableId ? `${d.refTable} (this table)` : d.refTable}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {/* Formula editor */}
        {type === "formula" && (
          <>
            <div className="border-t border-line" />
            <FormulaEditor
              expr={formulaExpr}
              onExprChange={setFormulaExpr}
              resultType={formulaResultType}
              onResultTypeChange={setFormulaResultType}
              availableFields={availableFields}
              onValidate={onValidateFormula}
              onCheckChange={setFormulaCheck}
            />
          </>
        )}

        {/* Error banner — role="alert" so screen readers announce it on submit (#161). */}
        {error && (
          <div
            role="alert"
            className="rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[11px] text-danger"
          >
            {error}
          </div>
        )}

        {type !== "formula" && (
          <ValidationFields
            type={type}
            required={required}
            onRequiredChange={setRequired}
            unique={unique}
            onUniqueChange={setUnique}
            min={min}
            onMinChange={setMin}
            max={max}
            onMaxChange={setMax}
          />
        )}

        {/* Footer */}
        <div className="flex items-center gap-2 pt-1">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={createAnother}
              onChange={(e) => setCreateAnother(e.target.checked)}
              className="rounded-sm"
              style={{ accentColor: "var(--accent)" }}
            />
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
              add another
            </span>
          </label>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" type="button" onClick={handleSubmit} disabled={!canSubmit}>
              Add field
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
