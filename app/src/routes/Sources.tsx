import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "../components/Card";
import { Kpi } from "../components/Kpi";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { CatalogExplorer } from "../components/CatalogExplorer";
import { IconSearch, IconWand, IconArrowRight } from "../components/Icons";
import { cx } from "../lib/cx";
import { useDimensions, useSources, scanSources, deriveCanonical, type SourceInfo } from "../store";

/* Sources (pillar 1) — a work queue over the source REGISTRY, not a 1000-row dump.
   Facet rail collapses systems; search finds any column; status chips default to
   "needs attention" when there's work; the list is ranked by unmapped (rows at
   risk). "Wire a source" opens the warehouse catalog explorer. */

function rise(i: number) {
  return { className: "zz-rise", style: { animationDelay: `${i * 70}ms` } };
}

const PAGE = 25;
type RealStatus = "needs" | "clean" | "missing";
type Status = RealStatus | "all";

const statusOf = (s: SourceInfo): RealStatus =>
  s.unmapped > 0 ? "needs" : s.scanned && !s.present ? "missing" : "clean";

export function Sources() {
  const sources = useSources();
  const dims = useDimensions();
  const [q, setQ] = useState("");
  const [schema, setSchema] = useState<string | null>(null);
  const totalUnmapped = sources.reduce((n, s) => n + s.unmapped, 0);
  const [status, setStatus] = useState<Status | "all">(totalUnmapped > 0 ? "needs" : "all");
  const [shown, setShown] = useState(PAGE);
  const [scanning, setScanning] = useState(false);
  const [flash, setFlash] = useState<number | null>(null);
  const [catalog, setCatalog] = useState(false);

  // per-schema rollup for the facet rail
  const facets = useMemo(() => {
    const m = new Map<string, { schema: string; columns: number; unmapped: number; missing: number }>();
    for (const s of sources) {
      const k = s.table.split(".")[0];
      const e = m.get(k) ?? { schema: k, columns: 0, unmapped: 0, missing: 0 };
      e.columns += 1; e.unmapped += s.unmapped; if (s.scanned && !s.present) e.missing += 1;
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.unmapped - a.unmapped || a.schema.localeCompare(b.schema));
  }, [sources]);

  const counts = useMemo(() => {
    const c: Record<RealStatus, number> = { needs: 0, clean: 0, missing: 0 };
    for (const s of sources) c[statusOf(s)]++;
    return c;
  }, [sources]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sources.filter((s) =>
      (!schema || s.table.split(".")[0] === schema) &&
      (status === "all" || statusOf(s) === status) &&
      (!needle || `${s.table}.${s.column}`.toLowerCase().includes(needle)),
    );
  }, [sources, schema, status, q]);

  const visible = filtered.slice(0, shown);
  const systems = new Set(sources.map((s) => s.table.split(".")[0])).size;
  const atRisk = sources.reduce((n, s) => n + (s.unmapped > 0 ? s.rows : 0), 0);

  const scan = async () => { setScanning(true); const n = await scanSources(); setScanning(false); setFlash(n); setTimeout(() => setFlash(null), 2600); };
  const [derived, setDerived] = useState<string | null>(null);
  const derive = async (s: SourceInfo) => {
    const n = await deriveCanonical(s.dimId, s.table, s.column);
    setDerived(n > 0 ? `Imported ${n} master record${n === 1 ? "" : "s"} into ${s.dimension} from ${s.table}.${s.column}` : `${s.table}.${s.column} has no rows to import`);
    setTimeout(() => setDerived(null), 3200);
  };

  const CHIPS: { k: Status | "all"; label: string; n: number }[] = [
    { k: "needs", label: "Needs review", n: counts.needs },
    { k: "all", label: "All", n: sources.length },
    { k: "clean", label: "Clean", n: counts.clean },
    { k: "missing", label: "Not found", n: counts.missing },
  ];

  return (
    <div className="space-y-8">
      {catalog && <CatalogExplorer dims={dims} onClose={() => setCatalog(false)} />}

      <div className="zz-rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-3">Discovery</div>
          <h1 className="mt-1.5 font-display text-[clamp(28px,4vw,44px)] font-extrabold leading-none tracking-[-0.035em] text-ink">Sources</h1>
          <p className="mt-3 max-w-[56ch] text-ink-2">The warehouse columns wired to each master list. Scan flags the values not yet matched to a master record — before they go missing downstream.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" icon={<IconArrowRight className="h-4 w-4" />} onClick={() => setCatalog(true)}>Wire a source</Button>
          <Button icon={<IconWand className="h-4 w-4" />} onClick={scan} className="zz-glow-sm" disabled={scanning}>
            {scanning ? "Scanning…" : flash !== null ? `✓ scanned ${flash}` : "Scan sources"}
          </Button>
        </div>
      </div>

      {derived && <div className="rounded-lg border border-line bg-accent-wash px-4 py-2.5 font-mono text-[12px] text-accent">{derived}</div>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div {...rise(1)}><Kpi label="Source columns" value={String(sources.length)} /></div>
        <div {...rise(2)}><Kpi label="Source systems" value={String(systems)} /></div>
        <div {...rise(3)}><Kpi label="Unmapped values" value={String(totalUnmapped)} dir="down" /></div>
        <div {...rise(4)}><Kpi label="Rows at risk" value={atRisk.toLocaleString()} dir="down" /></div>
      </div>

      <div {...rise(5)} className="grid grid-cols-1 gap-6 lg:grid-cols-[200px_1fr]">
        {/* facet rail */}
        <Card className="h-max p-0">
          <div className="border-b border-line px-4 py-3 font-mono text-[10px] uppercase tracking-wider text-ink-3">Systems</div>
          <button type="button" onClick={() => { setSchema(null); setShown(PAGE); }}
            className={cx("flex w-full items-center justify-between px-4 py-2 text-left font-mono text-[11.5px] transition-colors", schema === null ? "bg-accent-wash text-accent" : "text-ink-2 hover:bg-hover")}>
            <span>All systems</span><span className="opacity-60">{sources.length}</span>
          </button>
          <div className="max-h-[420px] overflow-y-auto">
            {facets.map((f) => (
              <button key={f.schema} type="button" onClick={() => { setSchema(f.schema === schema ? null : f.schema); setShown(PAGE); }}
                className={cx("flex w-full items-center justify-between gap-2 px-4 py-2 text-left font-mono text-[11.5px] transition-colors", f.schema === schema ? "bg-accent-wash text-accent" : "text-ink-2 hover:bg-hover")}>
                <span className="truncate">{f.schema}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {f.unmapped > 0 && <span className="h-1.5 w-1.5 rounded-pill bg-warn" />}
                  <span className="opacity-60">{f.columns}</span>
                </span>
              </button>
            ))}
          </div>
        </Card>

        {/* main: search + chips + ranked list */}
        <Card className="p-0">
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
            <label className="flex min-w-[180px] flex-1 items-center gap-2 rounded-sm border border-line-2 bg-bg px-3 py-1.5 text-ink-3 focus-within:border-accent">
              <IconSearch className="h-4 w-4" />
              <input value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} placeholder="Search columns…"
                className="w-full bg-transparent font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3" />
            </label>
            <div className="flex flex-wrap items-center gap-1.5">
              {CHIPS.map((c) => (
                <button key={c.k} type="button" onClick={() => { setStatus(c.k); setShown(PAGE); }}
                  className={cx("rounded-sm px-2.5 py-1 font-mono text-[11px] transition-colors", status === c.k ? "bg-accent-wash text-accent" : "text-ink-3 hover:bg-hover hover:text-ink-2")}>
                  {c.label} <span className="opacity-60">{c.n}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-[1.6fr_auto_auto_auto] items-center gap-3 border-b border-line px-5 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink-3">
            <span>Column</span><span className="text-right">Rows</span><span className="text-right">Values</span><span className="text-right">Unmapped</span>
          </div>
          {visible.map((r) => {
            const tableName = r.table.split(".").slice(1).join(".") || r.table;
            return (
              <Link key={`${r.table}.${r.column}`} to="/app/mapping" className="group grid grid-cols-[1.6fr_auto_auto_auto] items-center gap-3 border-b border-line px-5 py-3 transition-colors hover:bg-hover">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-[12.5px] text-ink"><span className="text-ink-3">{r.table.split(".")[0]}.</span>{tableName.split(".").slice(-1)[0]}<span className="text-ink-3">.{r.column}</span></span>
                    {!r.present && r.scanned && <Badge>not found</Badge>}
                    {!r.scanned && <span className="font-mono text-[9px] text-ink-3">unscanned</span>}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-ink-3">→ {r.dimension}</div>
                </div>
                <span className="text-right font-mono text-[12px] text-ink-2 tabular-nums">{r.rows.toLocaleString()}</span>
                <span className="text-right font-mono text-[12px] text-ink-3 tabular-nums">{r.values}</span>
                <span className="flex items-center justify-end gap-2">
                  <button type="button" title="Import master records from this column's distinct values"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); derive(r); }}
                    className="grid h-6 w-6 place-items-center rounded-sm border border-line-2 text-ink-3 opacity-0 transition-opacity hover:border-accent hover:text-accent group-hover:opacity-100">
                    <IconWand className="h-3 w-3" />
                  </button>
                  {r.unmapped > 0 ? <Badge tone="warn">{r.unmapped}</Badge> : <Badge tone="ok">0</Badge>}
                </span>
              </Link>
            );
          })}
          {filtered.length === 0 && (
            <div className="px-5 py-12 text-center font-mono text-[12px] text-ink-3">
              {sources.length === 0 ? "no sources wired — use “Wire a source”" : "nothing matches this filter"}
            </div>
          )}
          {filtered.length > shown && (
            <div className="flex items-center justify-between px-5 py-3">
              <span className="font-mono text-[11px] text-ink-3">{visible.length} of {filtered.length}</span>
              <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + PAGE)}>Load more</Button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
