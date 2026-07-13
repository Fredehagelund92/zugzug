import React from "react";
import { Button } from "./Button";

interface RenameConfirmationProps {
  prev: string;
  next: string;
  variants: number;
  canUndo: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}

/** Overlay toast shown after a rename. Absolutely positioned so it does not
 *  shift the grid layout. The parent pane must have position: relative. */
export function RenameConfirmation({
  prev,
  next,
  variants,
  canUndo,
  onUndo,
  onDismiss,
}: RenameConfirmationProps): React.ReactElement {
  return (
    <div className="absolute bottom-4 left-4 z-30 flex flex-wrap items-center justify-between gap-3 rounded-sm border border-accent/40 bg-[color-mix(in_srgb,var(--accent)_9%,var(--surface-elevated))] px-4 py-2 font-mono text-[12px] text-accent shadow-lg">
      <span>
        Renamed &ldquo;{prev}&rdquo; → &ldquo;{next}&rdquo;.{" "}
        {variants.toLocaleString()} source value{variants === 1 ? "" : "s"} re-pointed.
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={!canUndo}
          onClick={onUndo}
        >
          Undo
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
