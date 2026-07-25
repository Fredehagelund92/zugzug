import { useEffect, useRef, useState } from "react";
import { cx } from "../lib/cx";

export interface FormulaCheck {
  ok: boolean;
  error?: string;
  warning?: string;
  sample?: string | null;
}

interface FormulaEditorProps {
  expr: string;
  onExprChange: (v: string) => void;
  resultType: "text" | "number" | "boolean";
  onResultTypeChange: (rt: "text" | "number" | "boolean") => void;
  /** Existing field labels a formula may reference (click-to-insert). */
  availableFields?: { field: string; label: string }[];
  /** Dry-run the expression against a sample record for live feedback. */
  onValidate?: (expr: string) => Promise<FormulaCheck>;
  /** Reports the latest validation result to the parent (for save-gating). */
  onCheckChange?: (check: FormulaCheck | null) => void;
  autoFocus?: boolean;
}

/** The shared formula authoring UI: expression box, click-to-insert field chips,
 *  a result-type toggle, and a debounced live sample/error line. Owned by both
 *  the add-field popover and the edit-formula popover. */
export function FormulaEditor({
  expr,
  onExprChange,
  resultType,
  onResultTypeChange,
  availableFields,
  onValidate,
  onCheckChange,
  autoFocus,
}: FormulaEditorProps) {
  const [check, setCheck] = useState<FormulaCheck | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // Debounced validation against a sample record.
  useEffect(() => {
    if (!onValidate) return;
    const trimmed = expr.trim();
    if (!trimmed) {
      setCheck(null);
      onCheckChange?.(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      onValidate(trimmed).then(
        (res) => {
          if (cancelled) return;
          setCheck(res);
          onCheckChange?.(res);
        },
        () => {
          if (cancelled) return;
          setCheck(null);
          onCheckChange?.(null);
        },
      );
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // onCheckChange intentionally omitted — a new identity each render would refire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expr, onValidate]);

  const insertFieldRef = (fieldLabel: string) => {
    // Bracket labels with spaces/punctuation so the parser reads them as one ref.
    const ref = /^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldLabel) ? fieldLabel : `[${fieldLabel}]`;
    onExprChange(expr.trim() === "" ? ref : `${expr}${expr.endsWith(" ") ? "" : " "}${ref}`);
    inputRef.current?.focus();
  };

  return (
    <div className="space-y-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">Formula</div>
      <textarea
        ref={inputRef}
        value={expr}
        onChange={(e) => onExprChange(e.target.value)}
        placeholder={'IF(variants > 0, "active", "inactive")'}
        rows={3}
        className="w-full resize-y rounded-sm border border-line-2 bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
      />

      {availableFields && availableFields.length > 0 && (
        <div className="space-y-1.5">
          <div className="font-mono text-[10px] text-ink-3">Insert a field</div>
          <div className="flex flex-wrap gap-1">
            {availableFields.map((f) => (
              <button
                key={f.field}
                type="button"
                onClick={() => insertFieldRef(f.label)}
                className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-2 transition-colors hover:border-line-2 hover:bg-hover"
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 font-mono text-[10px] text-ink-3">Result</span>
        <div className="flex gap-1">
          {(
            [
              ["text", "Text"],
              ["number", "Number"],
              ["boolean", "Checkbox"],
            ] as const
          ).map(([rt, lbl]) => (
            <button
              key={rt}
              type="button"
              onClick={() => onResultTypeChange(rt)}
              className={cx(
                "rounded-sm border px-2 py-0.5 font-mono text-[10px] transition-colors",
                resultType === rt
                  ? "border-accent bg-accent-wash text-ink"
                  : "border-line text-ink-2 hover:border-line-2 hover:bg-hover",
              )}
            >
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {check && !check.ok && (
        <div className="rounded-sm border border-danger/40 bg-danger/10 px-2 py-1 font-mono text-[10px] text-danger">
          {check.error}
        </div>
      )}
      {check && check.ok && check.warning && (
        <div className="rounded-sm border border-line-2 bg-surface-2 px-2 py-1 font-mono text-[10px] text-ink-2">
          Valid — but the first record cannot be calculated: {check.warning}
        </div>
      )}
      {check && check.ok && !check.warning && (
        <div className="font-mono text-[10px] text-ink-3">
          Example result: <span className="text-ink">{check.sample ?? "—"}</span>
        </div>
      )}

      <p className="font-mono text-[10px] leading-relaxed text-ink-3">
        Reference fields by name. Functions: IF, AND, OR, NOT, CONCAT, UPPER, LOWER, TRIM, COALESCE,
        ISBLANK, ROUND, ABS.
      </p>
    </div>
  );
}
