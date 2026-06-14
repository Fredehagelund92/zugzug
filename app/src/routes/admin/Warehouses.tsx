import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { authFetch } from "../../api";
import { PageHeader } from "../../components/PageHeader";
import { SkeletonList } from "../../components/Skeleton";
import { EmptyState } from "../../components/EmptyState";
import { Badge } from "../../components/Badge";

interface AdminWarehouseProjection {
  adapter: "disabled" | "motherduck" | string;
  configuredFrom: "env";
  envVarName: string | null;
  bootValidation: { ok: boolean; reason?: string };
  databases: Array<{
    id: string;
    databaseName: string;
    label: string | null;
    sourceCount: number;
    lastProbeAt: string | null;
    lastProbeError: string | null;
  }>;
}

export function Warehouses() {
  const [data, setData] = useState<AdminWarehouseProjection | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const r = await authFetch("/admin/warehouse");
      if (r.ok) {
        setData((await r.json()) as AdminWarehouseProjection);
      }
      setLoading(false);
    })();
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="System"
        title="Warehouse"
        lede="The deployment's warehouse adapter is configured by environment variables. Manage databases from the workspace's Settings → Warehouse page."
        count={data?.databases.length}
      />

      {loading ? (
        <SkeletonList rows={3} columns={["minmax(0,1fr)", 120, 80]} />
      ) : !data ? (
        <EmptyState
          title="Couldn't load warehouse info"
          body="Try refreshing. If the issue persists, check the server logs."
        />
      ) : (
        <div className="space-y-4">
          <div className="rounded-sm border border-line bg-surface-2 p-4">
            <div className="flex items-center gap-2">
              <span className="font-display text-[14px] font-semibold text-ink">Adapter</span>
              <Badge>{data.adapter}</Badge>
              {data.envVarName && (
                <span className="font-mono text-[11px] text-ink-3">
                  from env: {data.envVarName}
                </span>
              )}
            </div>
            <div className="mt-2 text-[12.5px] text-ink-2">
              {data.bootValidation.ok
                ? "Adapter loaded successfully at boot."
                : `Boot validation failed: ${data.bootValidation.reason ?? "unknown reason"}`}
            </div>
          </div>

          <div className="rounded-sm border border-line bg-surface">
            <div className="border-b border-line px-4 py-2 text-[12px] font-medium text-ink-2">
              Databases
            </div>
            {data.databases.length === 0 ? (
              <div className="px-4 py-6 text-[12.5px] text-ink-3">No databases registered.</div>
            ) : (
              <ul className="divide-y divide-line">
                {data.databases.map((db) => (
                  <li key={db.id} className="flex items-center justify-between px-4 py-3">
                    <div>
                      <div className="text-[13px] text-ink">{db.databaseName}</div>
                      {db.label && <div className="text-[11.5px] text-ink-3">{db.label}</div>}
                    </div>
                    <div className="flex items-center gap-3 text-[11.5px] text-ink-3">
                      <span>
                        {db.sourceCount} source{db.sourceCount === 1 ? "" : "s"}
                      </span>
                      {db.lastProbeError && <Badge tone="warn">probe error</Badge>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-[12.5px] text-ink-3">
            Need to add or remove a database?{" "}
            <Link
              to="/app/settings/warehouse"
              className="text-accent underline-offset-2 hover:underline"
            >
              Open Settings → Warehouse →
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
