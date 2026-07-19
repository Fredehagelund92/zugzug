import { useEffect, useState } from "react";
import { apiFetch } from "../../api";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
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
  "w-full rounded-sm bg-surface-2 border border-line-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors";

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
        lede="Isolated mapping environments. Each workspace is scoped to a warehouse connection and owns its own reference tables and audit trail."
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
      <div className="zz-fade-in">
        {loading ? (
          <SkeletonList
            rows={4}
            columns={[28, "minmax(0,1fr)"]}
            data-testid="workspaces-skeleton"
          />
        ) : tenants.length === 0 ? (
          <EmptyState
            title="No workspaces yet"
            body="Workspaces isolate mapping environments. Each scopes to a warehouse connection and owns its own reference tables."
            action={
              <Button size="sm" onClick={() => setShowForm(true)}>
                Create your first workspace
              </Button>
            }
          />
        ) : (
          <Panel padding="none" className="divide-y divide-line">
            {tenants.map((t) => (
              <div
                key={t.id}
                className="grid grid-cols-[28px_1fr] gap-3 items-start px-5 py-4 hover:bg-hover transition-colors group"
              >
                {/* Color chip — vertically centered with the label line */}
                <div className="pt-0.5 flex justify-center">
                  <div
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ background: t.color ?? WORKSPACE_COLORS[0] }}
                  />
                </div>

                {/* Two-tier content */}
                <div className="min-w-0 space-y-0.5">
                  {/* Primary line: label (click to edit) */}
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
                      className="rounded-sm w-full bg-surface-2 border border-accent px-2 py-0.5 text-sm text-ink focus:outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setDraftLabel(t.label);
                        setEditingId(t.id);
                      }}
                      className="font-body text-sm font-medium text-ink text-left hover:text-accent transition-colors truncate w-full"
                      title="Click to rename"
                    >
                      {t.label}
                    </button>
                  )}

                  {/* Secondary line: slug · warehouse · members · last activity */}
                  <div className="flex items-center gap-2 text-xs text-ink-3 truncate">
                    <code className="font-mono text-accent/70">{t.slug}</code>
                    <span className="text-ink-3/40">·</span>
                    <code className="font-mono truncate">{t.warehouse_id}</code>
                    <span className="text-ink-3/40">·</span>
                    <span className="shrink-0">
                      {t.member_count ?? 0} {(t.member_count ?? 0) === 1 ? "member" : "members"}
                    </span>
                    {t.last_activity_at && (
                      <>
                        <span className="text-ink-3/40">·</span>
                        <span className="shrink-0">updated {ago(t.last_activity_at)} ago</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </Panel>
        )}
      </div>

      {/* Create form — slides in when showForm is true */}
      {showForm && (
        <Panel className="zz-rise">
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
        </Panel>
      )}
    </div>
  );
}
