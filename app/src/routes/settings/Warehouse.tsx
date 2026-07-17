import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import {
  useWorkspaceInfo,
  useConnectionHealth,
  refreshConnectionHealth,
  type ConnectionHealth,
} from "../../store";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { useEngineerMode } from "../../lib/engineer-mode";
import { Scans } from "./Scans";
import { useTenant } from "../../lib/tenant-context";
import { fetchWarehouseDatabases } from "../../api";
import { DatabaseTable, type DatabaseRow } from "../../components/warehouse/DatabaseTable";
import { AddDatabaseDialog } from "../../components/warehouse/AddDatabaseDialog";
import { RemoveDatabaseConfirm } from "../../components/warehouse/RemoveDatabaseConfirm";

function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function HealthBadge({ state }: { state?: ConnectionHealth["warehouse"] }) {
  if (!state) {
    return <Badge dot>checking…</Badge>;
  }
  if (state.status === "disabled") {
    return <Badge dot>disabled</Badge>;
  }
  if (state.status === "error") {
    return (
      <span title={state.error}>
        <Badge tone="warn" dot>
          error · {ago(state.lastCheckedAt)}
        </Badge>
      </span>
    );
  }
  return (
    <Badge tone="ok" dot>
      ok · {ago(state.lastCheckedAt)}
    </Badge>
  );
}

function DatabasesSection() {
  const tenant = useTenant();
  const { engineer } = useEngineerMode();
  const isSuperAdmin = tenant.isSuperAdmin === true;
  const [databases, setDatabases] = useState<DatabaseRow[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [removing, setRemoving] = useState<DatabaseRow | null>(null);
  const [dbError, setDbError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setDbError(null);
    try {
      setDatabases(await fetchWarehouseDatabases());
    } catch (err) {
      setDbError(err instanceof Error ? err.message : "Could not reach the server.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <SettingsSection
      title="Warehouse databases"
      hint="Pick which MotherDuck databases this deployment uses. The token is loaded from the environment; databases are shared across all workspaces."
    >
      {!dbError && (
        <div className="mb-3 flex items-center gap-3 text-[12px] text-ink-2">
          <span>
            MotherDuck · {databases.length} database{databases.length === 1 ? "" : "s"} registered
          </span>
          {engineer && (
            <span className="font-mono text-[11px] text-ink-3">from env: MOTHERDUCK_TOKEN</span>
          )}
        </div>
      )}

      {dbError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-danger/40 bg-danger-soft px-4 py-2.5 font-mono text-[11.5px] text-danger">
          <span>Couldn&rsquo;t load databases — {dbError}</span>
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      ) : (
        <DatabaseTable
          databases={databases}
          canAdd={isSuperAdmin}
          onAdd={() => setShowAdd(true)}
          onRemove={isSuperAdmin ? (db) => setRemoving(db) : undefined}
        />
      )}

      {showAdd && (
        <AddDatabaseDialog
          onCancel={() => setShowAdd(false)}
          onAdded={async () => {
            setShowAdd(false);
            await refresh();
          }}
        />
      )}
      {removing && (
        <RemoveDatabaseConfirm
          database={removing}
          onCancel={() => setRemoving(null)}
          onRemoved={async () => {
            setRemoving(null);
            await refresh();
          }}
        />
      )}
    </SettingsSection>
  );
}

function ConnectionsSection() {
  const { engineer } = useEngineerMode();
  const tenant = useTenant();
  const wsInfo = useWorkspaceInfo();
  const adapterLabel = wsInfo
    ? wsInfo.adapter === "duckdb"
      ? "MotherDuck"
      : wsInfo.adapter[0]?.toUpperCase() + wsInfo.adapter.slice(1)
    : "…";
  const health = useConnectionHealth();
  const refreshHealth = useAsyncAction(async () => {
    await refreshConnectionHealth({ force: true });
  });

  return (
    <SettingsSection
      title="Connections"
      hint={
        engineer
          ? `Reads source values from your warehouse (${adapterLabel}); records live where the adapter's writability allows; team state lives in Postgres.`
          : "Where Zug Zug reads from and where your work is kept."
      }
      action={
        <Button
          variant="ghost"
          size="sm"
          loading={refreshHealth.isPending}
          onClick={() => void refreshHealth.run()}
        >
          Refresh
        </Button>
      }
    >
      {/* Warehouse — where source values come from */}
      <Panel padding="sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="font-display text-[14px] font-semibold text-ink">Warehouse</span>
            <Badge>{adapterLabel}</Badge>
          </div>
          <HealthBadge state={health?.warehouse} />
        </div>
        {engineer ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-2">
            <span>
              {wsInfo?.writable
                ? "scanned for source values & writes records via MERGE"
                : "scanned for source values — never written to"}
            </span>
          </div>
        ) : (
          <div className="mt-1 text-[12.5px] text-ink-2">
            Where Zug Zug looks for new values that need a record.
          </div>
        )}
      </Panel>

      {/* App — the collaborative layer (drafts, history, team) */}
      <Panel padding="sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="font-display text-[14px] font-semibold text-ink">App</span>
            <Badge>Postgres</Badge>
          </div>
          <HealthBadge state={health?.postgres} />
        </div>
        {engineer ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-2">
            <span>drafts · audit log · users · sessions · preferences</span>
          </div>
        ) : (
          <div className="mt-1 text-[12.5px] text-ink-2">
            Drafts, history, and your team — the collaborative layer.
          </div>
        )}
      </Panel>

      {tenant.isSuperAdmin && (
        <p className="text-[12.5px] text-ink-3">
          Need a fresh database?{" "}
          <Link
            to="/app/admin/warehouse"
            className="text-accent underline-offset-2 hover:underline"
          >
            Manage warehouses →
          </Link>
        </p>
      )}
    </SettingsSection>
  );
}

export function Warehouse() {
  return (
    <div className="space-y-8">
      <DatabasesSection />
      <ConnectionsSection />
      <div id="scans">
        <Scans />
      </div>
    </div>
  );
}
