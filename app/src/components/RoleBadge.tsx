import type { CurrentUser } from "../store";

interface RoleBadgeProps {
  role: CurrentUser["role"];
}

/** Visual signal for non-editor roles. Editor renders nothing (it's the default).
 *  Viewer gets a "read-only" pill so users immediately know they can't edit.
 *  Admin gets an "admin" pill so admins remember the elevated context. */
export function RoleBadge({ role }: RoleBadgeProps) {
  if (role === "editor") return null;
  if (role === "viewer") {
    return (
      <span className="inline-flex items-center rounded-sm border border-line-2 bg-surface-2 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-3">
        read-only
      </span>
    );
  }
  // admin
  return (
    <span className="inline-flex items-center rounded-sm border border-accent/40 bg-accent/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-accent">
      admin
    </span>
  );
}
