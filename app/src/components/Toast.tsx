import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";

export const TOAST_DURATION_MS = 2800;

export type ToastVariant = "success" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  action?: ToastAction;
}

let toasts: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const emit = () => listeners.forEach((l) => l());

function dismiss(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Drop all toasts — persistent errors have no timer, so tests need this. */
export function clearToasts(): void {
  toasts = [];
  emit();
}

/** Show a notice in the global toast stack (bottom-right). Successes
 *  auto-dismiss; errors persist until the user dismisses them so the
 *  timer never races a decision. Pass an optional `action` to surface
 *  a labelled button alongside the message (e.g. a Retry affordance). */
export function toast(
  message: string,
  variant: ToastVariant = "success",
  action?: ToastAction,
): void {
  const id = nextId++;
  toasts = [...toasts, { id, message, variant, action }];
  emit();
  if (variant !== "error") setTimeout(() => dismiss(id), TOAST_DURATION_MS);
}

/** Singleton stack — rendered once in AppShell. */
export function ToastStack(): React.ReactElement | null {
  const items = useSyncExternalStore(
    subscribe,
    () => toasts,
    () => toasts,
  );
  if (items.length === 0) return null;
  return createPortal(
    <div className="fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2" role="status">
      {items.map((t) => (
        <div
          key={t.id}
          className={cx(
            "zz-pop-in flex items-start gap-2 rounded-sm border px-3 py-2 font-mono text-[11.5px] shadow-lg",
            // washes are translucent; mix against surface-elevated so the
            // floating toast is opaque over any page content
            t.variant === "error"
              ? "border-danger/40 bg-[color-mix(in_srgb,var(--ak-danger)_14%,var(--surface-elevated))] text-danger"
              : "border-accent/40 bg-[color-mix(in_srgb,var(--accent)_9%,var(--surface-elevated))] text-accent",
          )}
        >
          <span className="min-w-0 flex-1 break-words">{t.message}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                dismiss(t.id);
                t.action!.onClick();
              }}
              className="shrink-0 font-semibold underline transition-colors hover:opacity-80"
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => dismiss(t.id)}
            className="shrink-0 text-current/60 transition-colors hover:text-current"
          >
            ×
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
