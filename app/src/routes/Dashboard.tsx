import { Link } from "react-router-dom";
import { Card } from "../components/Card";
import { Kpi } from "../components/Kpi";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Mark } from "../components/Mark";
import { PageHeader } from "../components/PageHeader";
import { IconWand, IconArrowRight, IconPlus } from "../components/Icons";
import { valueRows } from "../data";
import { useDimensions, useAudit, useDrafts, currentUser } from "../store";

const MarkBackdrop = () => (
  <Mark className="pointer-events-none absolute -right-2 -top-12 h-48 w-48 opacity-[0.05]" />
);

function rise(i: number) {
  return { className: "zz-rise", style: { animationDelay: `${i * 70}ms` } };
}

// "4541" → "4.5k", "964123" → "964k", "12" → "12"
function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function Dashboard() {
  const dims = useDimensions();
  const auditLog = useAudit();
  const draftsMap = useDrafts();
  const newCount = (id: string) =>
    dims.find((s) => s.id === id)?.values.filter((v) => v.status === "new").length ?? 0;
  const totalNew = dims.reduce((n, s) => n + s.values.filter((v) => v.status === "new").length, 0);
  const dimName = (id: string) => dims.find((s) => s.id === id)?.dimension ?? id;
  const staged = Object.values(draftsMap).filter(
    (d) =>
      d.status === "mapped" &&
      dims.find((s) => s.id === d.dimId)?.values.find((v) => v.value === d.raw)?.status === "new",
  );

  // Live KPI derivations — replace the static fixtures.
  // Values mapped = total raw-value entries already in the map tables.
  // Rows at risk = warehouse source rows behind currently-unmapped values.
  // Coverage = mapped rows / (mapped rows + at-risk rows).
  const valuesMapped = dims.reduce((n, d) => n + d.rows, 0);
  const rowsAtRisk = dims.reduce(
    (n, d) => n + d.values.filter((v) => v.status === "new").reduce((m, v) => m + valueRows(v), 0),
    0,
  );
  const rowsMapped = dims.reduce(
    (n, d) =>
      n + d.values.filter((v) => v.status === "mapped").reduce((m, v) => m + valueRows(v), 0),
    0,
  );
  const coverage =
    rowsMapped + rowsAtRisk > 0 ? (rowsMapped / (rowsMapped + rowsAtRisk)) * 100 : 100;
  const attentionTables = dims.filter((d) =>
    d.values.some((v) => v.status === "new"),
  ).length;
  const cleanTables = dims.length - attentionTables;

  const kpis: Array<{
    label: string;
    value: string;
    featured?: boolean;
    delta?: string;
    dir?: "up" | "down" | "warn";
  }> = [
    {
      label: "Tables",
      value: String(dims.length),
      delta: `${attentionTables} active · ${cleanTables} clean`,
      dir: attentionTables > 0 ? "warn" : undefined,
    },
    {
      label: "Values mapped",
      value: fmtK(valuesMapped),
      delta: undefined,
      dir: undefined,
    },
    {
      label: "New to resolve",
      value: String(totalNew),
      featured: totalNew > 0,
      delta: totalNew > 0 ? `across ${attentionTables} table${attentionTables === 1 ? "" : "s"}` : undefined,
      dir: totalNew > 0 ? "warn" : undefined,
    },
    {
      label: "Rows at risk",
      value: fmtK(rowsAtRisk),
      delta: rowsAtRisk > 0 ? "unmapped warehouse rows" : undefined,
      dir: rowsAtRisk > 0 ? "warn" : undefined,
    },
  ];

  if (dims.length === 0) {
    return (
      <div className="space-y-8">
        <PageHeader
          backdrop={<MarkBackdrop />}
          kicker="Master data"
          title="Your workspace is empty"
          lede="Create a master table to start reconciling messy source values to canonical ones. Each table maps a single dimension (countries, regions, post types, …) from your warehouse."
          meta={
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Link to="/app/tables">
                <Button icon={<IconPlus className="h-4 w-4" />}>Create your first table</Button>
              </Link>
              <Link to="/app/sources">
                <Button variant="secondary">Browse the warehouse</Button>
              </Link>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[var(--wide)] space-y-8 p-8">
      <PageHeader
        backdrop={<MarkBackdrop />}
        kicker="Master data"
        title="Value mapping overview"
        meta={
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px] text-ink-2">
            <span className="flex items-center gap-1.5">
              <span className="zz-live h-1.5 w-1.5 rounded-pill bg-accent" /> live
            </span>
            <span className="text-line-2">/</span>
            <span className="tabular-nums">{dims.length} tables</span>
            <span className="text-line-2">/</span>
            <span className="tabular-nums">{fmtK(valuesMapped)} values mapped</span>
            <span className="text-line-2">/</span>
            <span className="text-accent tabular-nums">{coverage.toFixed(1)}% coverage</span>
            <span className="text-line-2">/</span>
            <span className="text-warn tabular-nums">{totalNew} new to resolve</span>
            {staged.length > 0 && (
              <>
                <span className="text-line-2">/</span>
                <span className="text-staged tabular-nums">{staged.length} staged for review</span>
              </>
            )}
          </div>
        }
        action={
          <Link to="/app/triage">
            <Button icon={<IconWand className="h-4 w-4" />} className="zz-glow-sm">
              Resolve {totalNew} new
            </Button>
          </Link>
        }
      />

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {kpis.map((m, i) => (
          <div key={m.label} {...rise(1 + i)}>
            <Kpi
              label={m.label}
              value={m.value}
              featured={m.featured}
              delta={m.delta}
              dir={m.dir}
            />
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
                <Badge tone="staged" dot>
                  {staged.length} pending commit
                </Badge>
              </div>
              <Link to="/app/triage">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconArrowRight className="h-3.5 w-3.5" />}
                >
                  Review &amp; commit
                </Button>
              </Link>
            </div>
            <ul className="divide-y divide-line">
              {staged.slice(0, 5).map((d) => (
                <li
                  key={`${d.dimId}-${d.raw}`}
                  className="flex items-center gap-3 px-6 py-3 font-mono text-[12px]"
                >
                  <span
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-pill bg-surface-3 text-[9px] text-ink-2"
                    title={d.user.name}
                  >
                    {d.user.initials}
                  </span>
                  <span className="min-w-0 max-w-[34%] truncate text-ink">{d.raw}</span>
                  <IconArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate text-accent">{d.targetLabel}</span>
                  <span className="shrink-0 rounded-pill bg-surface-3 px-2 py-0.5 text-[10px] text-ink-2">
                    {dimName(d.dimId)}
                  </span>
                  <span className="hidden shrink-0 text-[10px] text-ink-2 tabular-nums sm:inline">
                    {d.user.id === currentUser.id ? "you" : d.user.name} · {d.at}
                  </span>
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
                  <Link
                    key={s.id}
                    to={`/app/tables?open=${s.id}&active=${s.id}&mode=match`}
                    className="group flex items-center gap-4 px-6 py-4 transition-colors hover:bg-hover"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-display text-[14px] font-semibold text-ink">
                          {s.dimension}
                        </span>
                        <span className="truncate font-mono text-[11px] text-ink-2">
                          {s.mapTable}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-3">
                        <div className="h-1.5 w-40 overflow-hidden rounded-pill bg-surface-2">
                          <div
                            className="h-full rounded-pill bg-accent"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="font-mono text-[11px] text-ink-2 tabular-nums">
                          {s.rows.toLocaleString()} rows
                        </span>
                      </div>
                    </div>
                    {n > 0 ? (
                      <Badge tone="warn" dot>
                        {n} new
                      </Badge>
                    ) : (
                      <Badge tone="ok" dot>
                        clean
                      </Badge>
                    )}
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
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-pill bg-surface-3 font-mono text-[9px] text-ink-2">
                    {e.user.initials}
                  </span>
                  <div className="min-w-0 flex-1 truncate text-[12.5px]">
                    <span className="text-ink">{e.action}</span>{" "}
                    <span className="text-ink-3">{e.detail}</span>
                  </div>
                  <span className="shrink-0 font-mono text-[10px] text-ink-2 tabular-nums">
                    {e.at}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
