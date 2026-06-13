import { useState, useEffect } from "react";
import { apiFetch } from "../../api";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { SkeletonList } from "../../components/Skeleton";

interface WarehouseDb {
  name: string;
  tableCount: number;
  connected: boolean;
}

export function Warehouses() {
  const [dbs, setDbs] = useState<WarehouseDb[]>([]);
  const [attached, setAttached] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch("/warehouses")
      .then(async (r) => {
        if (!r.ok) return;
        const body = (await r.json()) as { databases: WarehouseDb[]; attached: boolean };
        setAttached(body.attached);
        setDbs(body.databases);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="System"
        title="Warehouses"
        lede="MotherDuck databases available to this deployment. Read-only."
        count={loading || attached !== true ? undefined : dbs.length}
      />

      <div className="zz-rise" style={{ animationDelay: "80ms" }}>
        {loading ? (
          <SkeletonList rows={3} columns={["minmax(0,1fr)", 120, 80]} />
        ) : attached === false ? (
          <div className="border border-dashed border-line-2 p-8">
            <p className="text-sm text-ink-3 text-center">
              Warehouse not attached.{" "}
              <code className="font-mono text-xs bg-surface-2 px-1.5 py-0.5">
                ATTACH_WAREHOUSE=true
              </code>{" "}
              to enable.
            </p>
          </div>
        ) : dbs.length === 0 ? (
          <EmptyState title="No databases found" body="The warehouse connection succeeded but returned no databases." />
        ) : (
          <div className="border border-line divide-y divide-line bg-surface">
            <div className="grid grid-cols-[1fr_120px_80px] gap-4 items-center px-5 py-2.5">
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">
                Database
              </span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3 text-right">
                Tables
              </span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">
                Status
              </span>
            </div>
            {dbs.map((db, i) => (
              <div
                key={db.name}
                className="zz-rise grid grid-cols-[1fr_120px_80px] gap-4 items-center px-5 py-3.5 hover:bg-hover transition-colors group"
                style={{ animationDelay: `${100 + i * 40}ms` }}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-0.5 h-5 bg-accent opacity-40 group-hover:opacity-90 transition-opacity shrink-0" />
                  <code className="font-mono text-sm text-accent truncate">{db.name}</code>
                </div>
                <span className="font-mono text-sm text-ink-3 tabular-nums text-right">
                  {db.tableCount}
                </span>
                <span
                  className="font-mono text-[10px] flex items-center gap-1"
                  style={{ color: db.connected ? "var(--ak-ok)" : "var(--ink-3)" }}
                >
                  <span className={db.connected ? "animate-pulse" : ""}>●</span>
                  {db.connected ? "live" : "off"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
