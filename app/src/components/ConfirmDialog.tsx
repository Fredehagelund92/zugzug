import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Renders the confirm button with the danger variant. */
  danger?: boolean;
  /** Shows loading state on confirm button. */
  loading?: boolean;
  /** When set, requires the user to type this phrase exactly before confirming. */
  confirmPhrase?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/** Shared destructive-action confirm dialog. Esc / backdrop click cancel;
 *  focus lands on Cancel so a stray Enter doesn't fire the dangerous action. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  loading = false,
  confirmPhrase,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [phrase, setPhrase] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    const rafId = requestAnimationFrame(() => cancelRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === "Tab") {
        // Trap focus between cancel and confirm buttons inside the dialog.
        const focusables =
          dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(rafId);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onCancel]);

  useEffect(() => {
    if (!open) setPhrase("");
  }, [open]);

  if (!open) return null;

  const phraseRequired = confirmPhrase !== undefined;
  const phraseMatches = !phraseRequired || phrase === confirmPhrase;

  return (
    <div
      data-testid="confirm-dialog-backdrop"
      className="fixed inset-0 z-50 grid place-items-center bg-ink/50 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="w-full max-w-sm rounded-lg border border-line bg-surface-elevated p-5 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-dialog-title" className="font-display text-base font-bold text-ink">
          {title}
        </h2>
        {body && <div className="mt-2 text-[13px] text-ink-2">{body}</div>}
        {phraseRequired && (
          <input
            type="text"
            className="mt-3 w-full rounded-sm border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:ring-2 focus:ring-accent"
            placeholder={confirmPhrase}
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label={`Type ${confirmPhrase} to confirm`}
          />
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" size="sm" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            size="sm"
            loading={loading}
            disabled={!phraseMatches || loading}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
