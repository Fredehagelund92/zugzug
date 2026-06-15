import { useEffect, useState } from "react";
import { apiFetch } from "../../api";
import { Button } from "../../components/Button";
import { PageHeader } from "../../components/PageHeader";
import { SkeletonList } from "../../components/Skeleton";
import { EmptyState } from "../../components/EmptyState";
import { ago } from "../../components/sources/utils";
import { invalidate, subscribeInvalidate } from "../../store";
import { WorkspaceColorPicker } from "../../components/WorkspaceColorPicker";
import { WORKSPACE_COLORS } from "../../lib/workspace-colors";

interface Tenant {
  id: string;
  slug: string;
  label: string;
  color: string | null;
  warehouse_id: string;
  member_count?: number;
  last_activity_at?: string | null;
}

const inputCls =
  "w-full bg-surface border border-line-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors";

export function Workspaces() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [slug, setSlug] = useState("");
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<string>(WORKSPACE_COLORS[0]);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");

  const commitLabel = async (t: Tenant) => {
    const next = draftLabel.trim();
    setEditingId(null);
    if (!next || next === t.label) return;
    const r = await apiFetch(`/tenants/${encodeURIComponent(t.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: next }),
    });
    if (r.ok) {
      // Optimistic local update so the row reflects immediately even before
      // the refresh from invalidate.tenantList() lands.
      setTenants((prev) => prev.map((x) => (x.id === t.id ? { ...x, label: next } : x)));
      await invalidate.tenantList();
      // The switcher also displays this label — refresh memberships so the
      // rename propagates without a reload.
      await invalidate.memberships();
    }
  };

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
      body: JSON.stringify({ slug, label, color }),
    });
    if (r.ok) {
      setSlug("");
      setLabel("");
      setColor(WORKSPACE_COLORS[0]);
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
          <SkeletonList
            rows={4}
            columns={[20, 160, "minmax(0,1fr)", 140, 72, 120]}
            data-testid="workspaces-skeleton"
          />
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
            <div className="grid grid-cols-[20px_160px_1fr_140px_72px_120px] gap-4 items-center px-5 py-2.5">
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
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3 text-right">
                Members
              </span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">
                Last activity
              </span>
            </div>

            {tenants.map((t, i) => (
              <div
                key={t.id}
                className="zz-rise grid grid-cols-[20px_160px_1fr_140px_72px_120px] gap-4 items-center px-5 py-3.5 hover:bg-hover transition-colors group"
                style={{ animationDelay: `${120 + i * 40}ms` }}
              >
                {/* workspace color dot */}
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: t.color ?? WORKSPACE_COLORS[0] }}
                />

                {/* slug */}
                <code className="font-mono text-sm text-accent truncate">{t.slug}</code>

                {/* label — click to edit */}
                {editingId === t.id ? (
                  <input
                    autoFocus
                    value={draftLabel}
                    onChange={(e) => setDraftLabel(e.target.value)}
                    onBlur={() => void commitLabel(t)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      else if (e.key === "Escape") setEditingId(null);
                    }}
                    className="w-full bg-surface border border-accent px-2 py-1 text-sm text-ink focus:outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setDraftLabel(t.label);
                      setEditingId(t.id);
                    }}
                    className="font-body text-sm text-ink text-left hover:text-accent transition-colors truncate"
                    title="Click to rename"
                  >
                    {t.label}
                  </button>
                )}

                {/* warehouse badge */}
                <span className="font-mono text-xs text-ink-3 bg-surface-2 border border-line px-2 py-0.5 truncate inline-block">
                  {t.warehouse_id}
                </span>

                {/* member count */}
                <span className="font-mono text-sm text-ink-2 tabular-nums text-right">
                  {t.member_count ?? 0}
                </span>

                {/* last activity */}
                <span className="font-mono text-xs text-ink-3">
                  {t.last_activity_at ? `${ago(t.last_activity_at)} ago` : "—"}
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

          <div className="grid grid-cols-2 gap-4 mb-6">
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
          </div>

          <div className="mt-4 space-y-1.5">
            <label className="block font-mono text-[10px] uppercase tracking-widest text-ink-3">
              Color
            </label>
            <div className="flex items-center gap-4">
              <WorkspaceColorPicker value={color} onChange={setColor} />
              {/* Live avatar preview */}
              <div className="flex items-center gap-2 px-2 py-1 border border-line bg-surface rounded">
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 5,
                    background: color,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <span style={{ fontSize: 9, fontWeight: 700, color: "#fff" }}>
                    {label
                      ? (() => {
                          const words = label.trim().split(/\s+/).filter(Boolean);
                          return words.length === 1
                            ? words[0].slice(0, 2).toUpperCase()
                            : (words[0]![0]! + words[1]![0]!).toUpperCase();
                        })()
                      : "??"}
                  </span>
                </div>
                <span className="text-xs text-ink-2 truncate max-w-[140px]">
                  {label || "Preview"}
                </span>
              </div>
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
