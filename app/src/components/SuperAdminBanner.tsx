import type { ReactNode } from "react";

/** Amber elevation banner shown when a super-admin views a workspace they
 *  aren't actually a member of. See spec Section A.4. */
export function SuperAdminBanner({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 rounded-sm border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700">
      {children}
    </div>
  );
}
