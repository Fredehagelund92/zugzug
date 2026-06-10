import { Button } from "./Button";
import { cx } from "../lib/cx";

export interface ConflictBannerProps {
  conflict: {
    updatedBy: { id: string; name: string; initials: string };
    updatedAt: string;
  };
  /** Set when the action that conflicted touched multiple keys (e.g. merge).
   *  Banner copy names the first key + "(and N others)". */
  conflictedKeys?: string[];
  onRefresh: () => void;
  onKeepEditing: () => void;
}

function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** Per-row inline conflict banner shown above a canonical row in TablePane when
 *  a save was rejected because another user beat the current user to the row. */
export function ConflictBanner({
  conflict,
  conflictedKeys,
  onRefresh,
  onKeepEditing,
}: ConflictBannerProps) {
  const tail =
    conflictedKeys && conflictedKeys.length > 1
      ? ` (${conflictedKeys[0]} and ${conflictedKeys.length - 1} other${conflictedKeys.length === 2 ? "" : "s"})`
      : "";
  return (
    <div
      className={cx(
        "flex flex-wrap items-center justify-between gap-3 rounded-sm border border-warn/40 bg-warn-soft px-4 py-2.5",
        "font-mono text-[11.5px] text-warn",
      )}
      role="alert"
    >
      <span>
        This record was modified by <strong>{conflict.updatedBy.name}</strong>{" "}
        {ago(conflict.updatedAt)}. Your changes weren&apos;t saved.
        {tail && <em className="not-italic text-warn/80">{tail}</em>}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onKeepEditing}>
          Keep editing
        </Button>
        <Button variant="secondary" size="sm" onClick={onRefresh}>
          Refresh row
        </Button>
      </div>
    </div>
  );
}
