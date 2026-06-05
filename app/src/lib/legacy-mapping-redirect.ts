/* Pure function: legacy /app/mapping query → new URL target.
   Tested via app/test/legacy-mapping-redirect.test.ts. */
export function redirectTarget(params: URLSearchParams, validDimIds: Set<string>): string {
  const dimId = params.get("dimId");
  const view = params.get("view");
  const value = params.get("value");
  const filter = params.get("filter");

  if (dimId) {
    if (!validDimIds.has(dimId)) return "/app/tables?toast=missing-table";
    const q = new URLSearchParams();
    q.set("open", dimId);
    q.set("active", dimId);
    q.set("mode", "match");
    if (value) q.set("value", value);
    return `/app/tables?${q.toString()}`;
  }

  // No dimId → either ?view=all or bare /app/mapping. Both go to Triage.
  if (view === "all" || view == null) {
    const q = new URLSearchParams();
    if (filter && filter !== "new") q.set("filter", filter);
    const s = q.toString();
    return s ? `/app/triage?${s}` : "/app/triage";
  }
  // view=single without dimId → no useful target; land on Triage.
  return "/app/triage";
}
