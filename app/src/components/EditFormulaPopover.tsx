import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { toast } from "./Toast";
import { FormulaEditor, type FormulaCheck } from "./FormulaEditor";

interface EditFormulaPopoverProps {
  fieldLabel: string;
  initialExpr: string;
  initialResultType: "text" | "number" | "boolean";
  availableFields?: { field: string; label: string }[];
  onValidate?: (expr: string) => Promise<FormulaCheck>;
  onSave: (next: { expr: string; resultType: "text" | "number" | "boolean" }) => Promise<void>;
  onClose: () => void;
}

/** Edit an existing computed column's formula. A small centered dialog reusing
 *  the shared FormulaEditor — opened from the column header's "Edit formula…". */
export function EditFormulaPopover({
  fieldLabel,
  initialExpr,
  initialResultType,
  availableFields,
  onValidate,
  onSave,
  onClose,
}: EditFormulaPopoverProps) {
  const [expr, setExpr] = useState(initialExpr);
  const [resultType, setResultType] = useState(initialResultType);
  const [check, setCheck] = useState<FormulaCheck | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canSave = expr.trim().length > 0 && check?.ok !== false && !saving;

  const save = () => {
    if (!canSave) return;
    setSaving(true);
    onSave({ expr: expr.trim(), resultType }).then(
      () => onClose(),
      (err) => {
        setSaving(false);
        toast(err instanceof Error ? err.message : "Couldn't save the formula.", "error");
      },
    );
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10vh]"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit formula for ${fieldLabel}`}
        className="zz-pop-in w-[360px] max-w-full overflow-hidden rounded-sm border border-line-2 bg-surface-elevated shadow-pop"
      >
        <div className="h-px w-full bg-gradient-to-r from-transparent via-accent/70 to-transparent" />
        <div className="space-y-4 p-4">
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-3">
            Edit formula · {fieldLabel}
          </div>

          <FormulaEditor
            expr={expr}
            onExprChange={setExpr}
            resultType={resultType}
            onResultTypeChange={setResultType}
            availableFields={availableFields}
            onValidate={onValidate}
            onCheckChange={setCheck}
            autoFocus
          />

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" type="button" onClick={save} disabled={!canSave}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
