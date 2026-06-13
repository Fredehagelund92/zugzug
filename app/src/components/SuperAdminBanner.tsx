import type { ReactNode } from "react";

/** Elevation banner shown when a super-admin views a workspace they
 *  aren't actually a member of. See spec Section A.4. */
export function SuperAdminBanner({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 rounded-sm border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn"
    >
      {children}
    </div>
  );
}
