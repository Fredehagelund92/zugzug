import { Link } from "react-router-dom";
import { Card } from "../components/Card";
import { Kpi } from "../components/Kpi";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Mark } from "../components/Mark";
import { IconWand, IconArrowRight } from "../components/Icons";
import { metrics } from "../data";
import { useDimensions, useAudit, useDrafts, currentUser } from "../store";

function rise(i: number) {
  return { className: "zz-rise", style: { animationDelay: `${i * 70}ms` } };
}

export function Dashboard() {
  const dims = useDimensions();
  const auditLog = useAudit();
  const draftsMap = useDrafts();
  const newCount = (id: string) => dims.find((s) => s.id === id)!.values.filter((v) => v.status === "new").length;
  const totalNew = dims.reduce((n, s) => n + s.values.filter((v) => v.status === "new").length, 0);
  const dimName = (id: string) => dims.find((s) => s.id === id)?.dimension ?? id;
  const staged = Object.values(draftsMap).filter(
    (d) => d.status === "mapped" && dims.find((s) => s.id === d.dimId)?.values.find((v) => v.value === d.raw)?.status === "new",
  );
  return (
    <div className="space-y-8">
      {/* masthead */}
      <div className="zz-rise relative overflow-hidden">
        <Mark className="pointer-events-none absolute -right-2 -top-12 h-48 w-48 opacity-[0.05]" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-3">
              <span className="text-accent">[ </span>master data<span className="text-accent"> ]</span>
            </div>
            <h1 className="mt-1 font-display text-[clamp(34px,5vw,52px)] font-extrabold leading-[0.92] tracking-[-0.035em] text-ink">
              Value mapping overview
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px] text-ink-3">
              <span className="flex items-center gap-1.5 text-ink-2"><span className="zz-live h-1.5 w-1.5 rounded-pill bg-accent" /> live</span>
              <span className="text-line-2">/</span><span>{dims.length} tables</span>
              <span className="text-line-2">/</span><span>48.6k values mapped</span>
              <span className="text-line-2">/</span><span className="text-accent">98.2% coverage</span>
              <span className="text-line-2">/</span><span className="text-warn">{totalNew} new to resolve</span>
              {staged.length > 0 && <><span className="text-line-2">/</span><span className="text-accent">{staged.length} staged for review</span></>}
            </div>
          </div>
          <Link to="/app/mapping"><Button icon={<IconWand className="h-4 w-4" />} className="zz-glow-sm">Resolve {totalNew} new</Button></Link>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {metrics.map((m, i) => (
          <div key={m.label} {...rise(1 + i)}>
            <Kpi label={m.label} value={m.value} delta={m.delta} dir={m.dir} spark={m.spark} />
          </div>
        ))}
      </div>

      {/* staged drafts awaiting review/approve — the OLTP draft layer (Postgres) */}
      {staged.length > 0 && (
        <div {...rise(5)}>
          <Card className="p-0">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4">
              <div className="flex items-center gap-2.5">
                <h2 className="font-display text-lg font-semibold text-ink">Staged for review</h2>
                <Badge tone="warn" dot>{staged.length} pending commit</Badge>
              </div>
              <Link to="/app/mapping"><Button variant="secondary" size="sm" icon={<IconArrowRight className="h-3.5 w-3.5" />}>Review &amp; commit</Button></Link>
            </div>
            <ul className="divide-y divide-line">
              {staged.slice(0, 5).map((d) => (
                <li key={`${d.dimId}-${d.raw}`} className="flex items-center gap-3 px-6 py-3 font-mono text-[12px]">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-pill bg-surface-3 text-[9px] text-ink-2" title={d.user.name}>{d.user.initials}</span>
                  <span className="min-w-0 max-w-[34%] truncate text-ink">{d.raw}</span>
                  <IconArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate text-accent">{d.targetLabel}</span>
                  <span className="shrink-0 rounded-pill bg-surface-3 px-2 py-0.5 text-[10px] text-ink-3">{dimName(d.dimId)}</span>
                  <span className="hidden shrink-0 text-[10px] text-ink-3 sm:inline">{d.user.id === currentUser.id ? "you" : d.user.name} · {d.at}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.3fr_1fr]">
        {/* mapping seeds */}
        <div {...rise(5)}>
          <Card className="p-0">
            <div className="flex items-center justify-between border-b border-line px-6 py-4">
              <h2 className="font-display text-lg font-semibold text-ink">Mapping seeds</h2>
              <span className="font-mono text-xs text-ink-3">{dims.length} tables</span>
            </div>
            <div className="divide-y divide-line">
              {dims.map((s) => {
                const total = s.values.length;
                const mapped = s.values.filter((v) => v.current).length;
                const pct = Math.round((mapped / total) * 100);
                const n = newCount(s.id);
                return (
                  <Link key={s.id} to="/app/mapping" className="group flex items-center gap-4 px-6 py-4 transition-colors hover:bg-hover">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-display text-[14px] font-semibold text-ink">{s.dimension}</span>
                        <span className="truncate font-mono text-[11px] text-ink-3">{s.mapTable}</span>
                      </div>
                      <div className="mt-2 flex items-center gap-3">
                        <div className="h-1.5 w-40 overflow-hidden rounded-pill bg-surface-2">
                          <div className="h-full rounded-pill bg-accent" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="font-mono text-[11px] text-ink-3">{s.rows.toLocaleString()} rows</span>
                      </div>
                    </div>
                    {n > 0 ? <Badge tone="warn" dot>{n} new</Badge> : <Badge tone="ok" dot>clean</Badge>}
                  </Link>
                );
              })}
            </div>
          </Card>
        </div>

        {/* new-value inbox */}
        <div {...rise(6)}>
          <Card className="p-0">
            <div className="flex items-center justify-between border-b border-line px-6 py-4">
              <h2 className="font-display text-lg font-semibold text-ink">Activity</h2>
              <span className="font-mono text-xs text-ink-3">team</span>
            </div>
            <ul className="divide-y divide-line">
              {auditLog.slice(0, 7).map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-6 py-3">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-pill bg-surface-3 font-mono text-[9px] text-ink-2">{e.user.initials}</span>
                  <div className="min-w-0 flex-1 truncate text-[12.5px]">
                    <span className="text-ink">{e.action}</span> <span className="text-ink-3">{e.detail}</span>
                  </div>
                  <span className="shrink-0 font-mono text-[10px] text-ink-3">{e.at}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
