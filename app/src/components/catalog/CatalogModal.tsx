import { useEffect } from "react";
import { IconX } from "../Icons";
import { CatalogBrowser } from "./CatalogBrowser";

export function CatalogModal(props: { open: boolean; onClose: () => void }): JSX.Element | null {
  const { open, onClose } = props;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 bg-ink/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="flex h-full items-center justify-center p-4">
        <div
          role="dialog"
          aria-label="Add source"
          className="flex h-[90vh] w-[92vw] max-w-[1400px] flex-col overflow-hidden rounded-lg border border-line-2 bg-surface-elevated shadow-pop"
          onClick={(e) => e.stopPropagation()}
        >
          {/* header */}
          <div className="flex items-center border-b border-line px-5 py-3">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
                Warehouse catalog
              </div>
              <h2 className="font-display text-lg font-extrabold tracking-tight text-ink">
                Add source
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="ml-auto grid h-8 w-8 place-items-center rounded-sm border border-line-2 text-ink-3 transition-colors hover:border-ink-3 hover:text-ink"
            >
              <IconX className="h-4 w-4" />
            </button>
          </div>

          {/* body */}
          <div className="min-h-0 flex-1 overflow-hidden">
            <CatalogBrowser />
          </div>
        </div>
      </div>
    </div>
  );
}
