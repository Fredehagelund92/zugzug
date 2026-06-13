import { useEffect, useState } from "react";
import { apiFetch } from "../../api";
import { Button } from "../../components/Button";
import { PageHeader } from "../../components/PageHeader";
import { WarehousePicker } from "../../components/WarehousePicker";
import { SkeletonList } from "../../components/Skeleton";
import { EmptyState } from "../../components/EmptyState";
import { invalidate, subscribeInvalidate } from "../../store";

interface Tenant {
  id: string;
  slug: string;
  label: string;
  warehouse_id: string;
}

const inputCls =
  "w-full bg-surface border border-line-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors";

export function Workspaces() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [slug, setSlug] = useState("");
  const [label, setLabel] = useState("");
  const [warehouseId, setWarehouseId] = useState("default");
  const [creating, setCreating] = useState(false);

  const refresh = async () => {
    const r = await apiFetch("/tenants");
    if (r.ok) setTenants(((await r.json()) as { tenants: Tenant[] }).tenants);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const unsub = subscribeInvalidate("tenantList", () => {
      void refresh();
    });
    return unsub;
  }, []);

  const create = async () => {
    if (!slug || !label) return;
    setCreating(true);
    const r = await apiFetch("/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, label, warehouseId }),
    });
    if (r.ok) {
      setSlug("");
      setLabel("");
      setWarehouseId("default");
      setShowForm(false);
      invalidate.tenantList();
      // Creating a workspace auto-joins the super-admin per the server, so
      // refresh memberships so the switcher dropdown gains the row.
      await invalidate.memberships();
    }
    setCreating(false);
  };

  return (
    <div className="space-y-8">
      <PageHeader
        kicker="System"
        title="Workspaces"
        lede="Isolated reconciliation environments. Each workspace is scoped to a warehouse connection and owns its own canonical tables and audit trail."
        count={loading ? undefined : tenants.length}
        action={
          <Button
            variant={showForm ? "secondary" : "primary"}
            size="sm"
            onClick={() => setShowForm((v) => !v)}
          >
            {showForm ? "Cancel" : "+ New workspace"}
          </Button>
        }
      />

      {/* Workspace list */}
      <div className="zz-rise" style={{ animationDelay: "80ms" }}>
        {loading ? (
          <SkeletonList rows={4} columns={[20, 160, "minmax(0,1fr)", 140]} data-testid="workspaces-skeleton" />
        ) : tenants.length === 0 ? (
          <EmptyState
            title="No workspaces yet"
            body="Workspaces isolate reconciliation environments. Each scopes to a warehouse connection and owns its own canonical tables."
            action={
              <Button size="sm" onClick={() => setShowForm(true)}>
                Create your first workspace
              </Button>
            }
          />
        ) : (
          <div className="border border-line divide-y divide-line bg-surface">
            {/* Column headers */}
            <div className="grid grid-cols-[20px_160px_1fr_140px] gap-4 items-center px-5 py-2.5">
              <span />
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">
                Slug
              </span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">
                Label
              </span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">
                Warehouse
              </span>
            </div>

            {tenants.map((t, i) => (
              <div
                key={t.id}
                className="zz-rise grid grid-cols-[20px_160px_1fr_140px] gap-4 items-center px-5 py-3.5 hover:bg-hover transition-colors group"
                style={{ animationDelay: `${120 + i * 40}ms` }}
              >
                {/* left accent bar */}
                <div className="w-0.5 h-6 bg-accent opacity-40 group-hover:opacity-90 transition-opacity" />

                {/* slug */}
                <code className="font-mono text-sm text-accent truncate">{t.slug}</code>

                {/* label */}
                <span className="font-body text-sm text-ink">{t.label}</span>

                {/* warehouse badge */}
                <span className="font-mono text-xs text-ink-3 bg-surface-2 border border-line px-2 py-0.5 truncate inline-block">
                  {t.warehouse_id}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create form — slides in when showForm is true */}
      {showForm && (
        <div className="zz-rise border border-line-2 bg-surface-2 p-6">
          <div className="flex items-center gap-2.5 mb-5">
            <div className="w-0.5 h-4 bg-accent flex-shrink-0" />
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-2">
              New workspace
            </span>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="space-y-1.5">
              <label className="block font-mono text-[10px] uppercase tracking-widest text-ink-3">
                Slug
              </label>
              <input
                className={inputCls + " font-mono"}
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="my-workspace"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <label className="block font-mono text-[10px] uppercase tracking-widest text-ink-3">
                Label
              </label>
              <input
                className={inputCls}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="My Workspace"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block font-mono text-[10px] uppercase tracking-widest text-ink-3">
                Warehouse ID
              </label>
              <WarehousePicker value={warehouseId} onChange={setWarehouseId} />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-xs text-ink-3">
              The slug becomes the URL identifier and cannot be changed after creation.
            </p>
            <Button onClick={create} loading={creating} disabled={!slug || !label}>
              Create workspace
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
