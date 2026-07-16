import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchUnmappedSample, type SourceInfo, type UnmappedSample } from "../../store";
import { useNavLinks } from "../../lib/use-tenant-navigate";

/* ExpandedDrill — the "Top unmapped values" sample that hangs under an
   expanded <LedgerRow>. Extracted from `routes/Sources.tsx` alongside
   LedgerRow so both can be reused by per-table workbench mode bodies. */

export function ExpandedDrill({ row }: { row: SourceInfo }) {
  const [sample, setSample] = useState<UnmappedSample[] | "loading" | "error">("loading");
  const nav = useNavLinks();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await fetchUnmappedSample(row.dimId, row.table, row.column, 8);
        if (alive) setSample(s);
      } catch {
        if (alive) setSample("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [row.dimId, row.table, row.column]);

  return (
    <div className="border-t border-line/60 bg-bg/30 px-4 py-4 md:pl-[68px]">
      <div className="font-mono text-[9.5px] uppercase tracking-[0.22em] text-ink-3">
        Top unmapped values
        {row.unmapped > 0 ? ` — showing up to 8 of ${row.unmapped.toLocaleString()}` : ""}
      </div>
      {sample === "loading" ? (
        <div className="mt-2 text-[12px] text-ink-3">loading…</div>
      ) : sample === "error" ? (
        <div className="mt-2 text-[12px] text-danger">
          couldn&apos;t load — is the warehouse attached?
        </div>
      ) : sample.length === 0 ? (
        row.unmapped > 0 ? (
          <div className="mt-2 text-[12px] text-ink-3">
            Run a scan — the unmapped count is cached; the sample needs a live read.
          </div>
        ) : (
          <div className="mt-2 text-[12px] text-ok">No unmapped values here.</div>
        )
      ) : (
        <ul className="mt-3 grid gap-1.5">
          {sample.map((s, i) => (
            <li key={i} className="grid grid-cols-[1fr_auto] items-baseline gap-3">
              <span className="truncate font-mono text-[12.5px] text-ink">{s.raw}</span>
              <span className="shrink-0 text-[11.5px] tabular-nums text-ink-3">
                {s.rows.toLocaleString()} rows
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex items-center gap-3 text-[11.5px] text-ink-3">
        <Link to={nav.table(row.dimId, "match")} className="text-accent hover:underline">
          Open in Map values →
        </Link>
        <span>→ {row.dimension}</span>
      </div>
    </div>
  );
}
