import { useSyncStatus } from "../store";
import { cx } from "../lib/cx";

/** Topbar sync state — renders nothing at idle so the chrome stays calm. */
export function SyncPill() {
  const status = useSyncStatus();
  if (status === "idle") return null;
  return (
    <span
      role="status"
      className={cx(
        "flex items-center gap-1.5 rounded-pill px-2.5 py-1 font-mono text-[10.5px] transition-colors",
        status === "saving" ? "bg-accent-wash text-accent" : "bg-surface-2 text-ink-3",
      )}
    >
      <span
        aria-hidden
        className={cx(
          "h-1.5 w-1.5 rounded-pill",
          status === "saving" ? "animate-pulse bg-accent" : "bg-ok",
        )}
      />
      {status === "saving" ? "Saving…" : "Saved"}
    </span>
  );
}
