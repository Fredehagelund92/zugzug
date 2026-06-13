import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../../api";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { SkeletonList } from "../../components/Skeleton";
import { invalidate, subscribeInvalidate } from "../../store";

interface WarehouseDb {
  name: string;
  tableCount: number;
  connected: boolean;
}

const NAME_RE = /^[a-z][a-z0-9_]{2,62}$/;

const inputCls =
  "w-full bg-surface border border-line-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors";

export function Warehouses() {
  const [dbs, setDbs] = useState<WarehouseDb[]>([]);
  const [attached, setAttached] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  // Create form state
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await apiFetch("/admin/warehouses");
    if (r.ok) {
      const body = (await r.json()) as { databases: WarehouseDb[]; attached: boolean };
      setAttached(body.attached);
      setDbs(body.databases);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unsub = subscribeInvalidate("warehouses", () => {
      void refresh();
    });
    return unsub;
  }, [refresh]);

  const existingNames = dbs.map((d) => d.name);
  const localError = !name
    ? null
    : !NAME_RE.test(name)
      ? "Lowercase letters, digits, underscore. 3-63 chars. Starts with a letter."
      : existingNames.includes(name)
        ? "A database with this name already exists."
        : null;

  const reset = () => {
    setName("");
    setServerError(null);
    setShowForm(false);
  };

  const create = async () => {
    if (!name || localError) return;
    setCreating(true);
    setServerError(null);
    try {
      const r = await apiFetch("/admin/warehouses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setServerError(body.error || `Failed (${r.status})`);
        return;
      }
      invalidate.warehouses();
      reset();
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="System"
        title="Warehouses"
        lede="MotherDuck databases available to this deployment."
        count={loading || attached !== true ? undefined : dbs.length}
        action={
          attached === true ? (
            <Button
              variant={showForm ? "secondary" : "primary"}
              size="sm"
              onClick={() => (showForm ? reset() : setShowForm(true))}
            >
              {showForm ? "Cancel" : "+ New database"}
            </Button>
          ) : undefined
        }
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

      {/* Create form — matches Workspaces.tsx idiom */}
      {showForm && (
        <div className="zz-rise border border-line-2 bg-surface-2 p-6">
          <div className="flex items-center gap-2.5 mb-5">
            <div className="w-0.5 h-4 bg-accent flex-shrink-0" />
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-2">
              New database
            </span>
          </div>

          <div className="mb-5">
            <div className="space-y-1.5 max-w-sm">
              <label className="block font-mono text-[10px] uppercase tracking-widest text-ink-3">
                Database name
              </label>
              <input
                className={inputCls + " font-mono"}
                value={name}
                onChange={(e) => {
                  setName(e.target.value.toLowerCase());
                  setServerError(null);
                }}
                placeholder="acme_prod"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !creating && name && !localError) {
                    e.preventDefault();
                    void create();
                  }
                }}
              />
              {(localError || serverError) && (
                <p className="font-mono text-[11px] text-red-500">{localError ?? serverError}</p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-xs text-ink-3">
              Creates a fresh MotherDuck database in your account. Appears in the workspace picker
              immediately.
            </p>
            <Button onClick={create} loading={creating} disabled={!name || !!localError}>
              Create database
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
