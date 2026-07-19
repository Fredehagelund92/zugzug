import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { cx } from "../../lib/cx";
import {
  useWorkspaceInfo,
  useConnectionHealth,
  refreshConnectionHealth,
  type ConnectionHealth,
} from "../../store";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { SettingsPageHeader } from "../../components/settings/SettingsPageHeader";
import { Scans } from "./Scans";
import { useTenant } from "../../lib/tenant-context";
import { fetchWarehouseDatabases } from "../../api";
import { DatabaseTable, type DatabaseRow } from "../../components/warehouse/DatabaseTable";
import { AddDatabaseDialog } from "../../components/warehouse/AddDatabaseDialog";
import { RemoveDatabaseConfirm } from "../../components/warehouse/RemoveDatabaseConfirm";

type ConnState = ConnectionHealth["warehouse"];

function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function HealthBadge({ state }: { state?: ConnState }) {
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

/** Left status spine colour for a connection card, keyed to its health. */
function spineTone(state?: ConnState): string {
  if (!state || state.status === "disabled") return "bg-line-2";
  if (state.status === "error") return "bg-warn";
  return "bg-ok";
}

/* ------------------------------------------------------------------ header */

/** Compact connection-health rollup, right-aligned in the page header. */
function StatusPill() {
  const health = useConnectionHealth();
  const states = [health?.warehouse, health?.postgres];
  const loaded = health != null;
  const anyError = states.some((s) => s?.status === "error");
  const checkedAt = health?.warehouse?.lastCheckedAt ?? health?.postgres?.lastCheckedAt ?? null;

  const dot = !loaded ? "bg-ink-3" : anyError ? "bg-warn" : "bg-ok";
  const ring = !loaded
    ? ""
    : anyError
      ? "shadow-[0_0_0_3px_var(--ak-warn-soft)]"
      : "shadow-[0_0_0_3px_var(--ak-ok-soft)]";
  const label = !loaded
    ? "Checking connections…"
    : anyError
      ? "A connection needs attention"
      : "Everything reachable";

  return (
    <div className="inline-flex items-center gap-2.5 rounded-pill border border-line bg-surface px-3.5 py-1.5">
      <span className={cx("h-2 w-2 shrink-0 rounded-full", dot, ring)} />
      <span className="text-[12.5px] font-medium text-ink-2">{label}</span>
      <span className="font-mono text-[10px] text-ink-3">
        2 connections{checkedAt ? ` · ${ago(checkedAt)}` : ""}
      </span>
    </div>
  );
}

/* --------------------------------------------------------------- databases */

function DatabasesSection() {
  const tenant = useTenant();
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
      bare
    >
      <div className="space-y-2">
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
      </div>

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

/* -------------------------------------------------------------- connections */

function ConnCard({
  name,
  tag,
  state,
  desc,
  stats,
}: {
  name: string;
  tag: string;
  state?: ConnState;
  desc: string;
  stats: { k: string; v: string }[];
}) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-line bg-surface p-4">
      <div className={cx("absolute inset-y-0 left-0 w-[3px]", spineTone(state))} />
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-display text-[14.5px] font-semibold text-ink">{name}</span>
          <Badge>{tag}</Badge>
        </div>
        <HealthBadge state={state} />
      </div>
      <p className="mt-2 text-[12.5px] text-ink-2">{desc}</p>
      <div className="mt-3 flex gap-8 border-t border-line pt-3">
        {stats.map((s) => (
          <div key={s.k}>
            <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-3">
              {s.k}
            </div>
            <div className="mt-0.5 text-[12.5px] font-medium text-ink">{s.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectionsSection() {
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
      hint="Where Zug Zug reads from and where your work is kept."
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
      bare
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <ConnCard
          name="Warehouse"
          tag={adapterLabel}
          state={health?.warehouse}
          desc="Where Zug Zug looks for new values that need a record."
          stats={[
            { k: "Access", v: wsInfo?.writable ? "Read + write" : "Read only" },
            { k: "Reads", v: "Source values" },
          ]}
        />
        <ConnCard
          name="App"
          tag="Postgres"
          state={health?.postgres}
          desc="Drafts, history, and your team — the collaborative layer."
          stats={[
            { k: "Access", v: "Read + write" },
            { k: "Holds", v: "Drafts · audit · team" },
          ]}
        />
      </div>

      {tenant.isSuperAdmin && (
        <p className="mt-3 text-[12.5px] text-ink-3">
          Need a fresh database?{" "}
          <Link to="/app/admin/warehouse" className="text-accent underline-offset-2 hover:underline">
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
      <SettingsPageHeader
        title="Warehouse"
        subtitle="Where Zug Zug reads source values from, and where your team’s work is kept."
        aside={<StatusPill />}
      />
      <DatabasesSection />
      <ConnectionsSection />
      <div id="scans">
        <Scans />
      </div>
    </div>
  );
}
