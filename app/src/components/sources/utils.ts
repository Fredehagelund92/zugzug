/* Shared helpers for the Sources surface — kept here so both the route-local
   <SchemaSection>/<EmptyState> in `routes/Sources.tsx` and the extracted
   <LedgerRow>/<ExpandedDrill> components consume one source of truth. */

export const SCHED_LABEL: Record<string, string> = {
  "15m": "auto 15m",
  hourly: "auto hourly",
  daily: "auto daily",
};

export const STALE_DAYS = 7;

export function ago(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

export function daysAgo(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}
