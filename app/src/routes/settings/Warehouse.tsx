import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
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
import { Tokens } from "./Tokens";
import { useTenant } from "../../lib/tenant-context";
import { can } from "../../lib/permissions";
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

  async function refresh(): Promise<void> {
    setDatabases(await fetchWarehouseDatabases());
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <SettingsSection
      title="Warehouse databases"
      hint="The MotherDuck token is loaded from the deployment's environment. Databases are shared across all workspaces."
    >
      <div className="mb-3 flex items-center gap-3 text-[12px] text-ink-2">
        <span>
          MotherDuck · {databases.length} database{databases.length === 1 ? "" : "s"} registered
        </span>
        {engineer && (
          <span className="font-mono text-[11px] text-ink-3">from env: MOTHERDUCK_TOKEN</span>
        )}
      </div>

      <DatabaseTable
        databases={databases}
        canAdd={isSuperAdmin}
        onAdd={() => setShowAdd(true)}
        onRemove={isSuperAdmin ? (db) => setRemoving(db) : undefined}
      />

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
  const adapterLabel = wsInfo ? wsInfo.adapter[0]?.toUpperCase() + wsInfo.adapter.slice(1) : "…";
  const health = useConnectionHealth();
  const refreshHealth = useAsyncAction(async () => {
    await refreshConnectionHealth({ force: true });
  });

  return (
    <SettingsSection
      title="Connections"
      hint={
        engineer
          ? `Reads source values from your warehouse (${adapterLabel}); master records live where the adapter's writability allows; team state lives in Postgres.`
          : "Where Zug Zug reads from and where your work is kept."
      }
    >
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          loading={refreshHealth.isPending}
          onClick={() => void refreshHealth.run()}
        >
          Refresh
        </Button>
      </div>

      {/* Warehouse — where source values come from */}
      <div className="rounded-sm border border-line bg-surface-2 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="font-display text-[14px] font-semibold text-ink">Warehouse</span>
            <Badge>{adapterLabel}</Badge>
          </div>
          <HealthBadge state={health?.warehouse} />
        </div>
        {engineer ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-2">
            {wsInfo?.warehouseDb && (
              <>
                <span>{wsInfo.warehouseDb}</span>
                <span>·</span>
              </>
            )}
            <span>
              {wsInfo?.writable
                ? "scanned for source values & writes canonical via MERGE"
                : "scanned for source values — never written to"}
            </span>
          </div>
        ) : (
          <div className="mt-1 text-[12.5px] text-ink-2">
            Where Zug Zug looks for new values that need a master record.
          </div>
        )}
      </div>

      {/* App — the collaborative layer (drafts, history, team) */}
      <div className="rounded-sm border border-line bg-surface-2 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="font-display text-[14px] font-semibold text-ink">App</span>
            <Badge tone="accent">Postgres</Badge>
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
      </div>

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
  const tenant = useTenant();
  const canViewTokens = can(tenant, "settings.tokens.view");
  return (
    <div className="space-y-8">
      <DatabasesSection />
      <ConnectionsSection />
      <div id="scans">
        <Scans />
      </div>
      {canViewTokens && (
        <div id="tokens">
          <Tokens />
        </div>
      )}
    </div>
  );
}
