import { useState, useEffect, useMemo, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../../api";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { SkeletonList } from "../../components/Skeleton";
import { AuditTimeline } from "../../components/AuditTimeline";
import type { AuditEntry } from "../../store";

export function Audit() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [params, setParams] = useSearchParams();

  // URL-persisted filter state — single source of truth.
  const tenantParam = params.get("tenant") ?? "";
  const typeParam = params.get("type") ?? "";
  const onlyElevated = params.get("elevated") === "1";
  const query = params.get("q") ?? "";

  const [tenantInput, setTenantInput] = useState(tenantParam);
  useEffect(() => setTenantInput(tenantParam), [tenantParam]);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params);
      if (value && value.length > 0) next.set(key, value);
      else next.delete(key);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const load = useCallback(async (tenantId?: string) => {
    setLoading(true);
    try {
      const qs = tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}&limit=200` : "?limit=200";
      const r = await apiFetch(`/audit${qs}`);
      if (r.ok) setRows((await r.json()) as AuditEntry[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(tenantParam.trim() || undefined);
  }, [load, tenantParam]);

  const eventTypes = useMemo(
    () => Array.from(new Set(rows.map((r) => r.action))).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (onlyElevated) {
        const meta = r.metadata as { actor_super_admin?: boolean } | null | undefined;
        if (meta?.actor_super_admin !== true) return false;
      }
      if (typeParam && r.action !== typeParam) return false;
      if (q) {
        const hay = `${r.action} ${r.detail ?? ""} ${r.user.name}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, onlyElevated, typeParam, query]);

  const handleTenantSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setParam("tenant", tenantInput.trim() || null);
  };

  const activeFilterCount =
    (tenantParam ? 1 : 0) + (typeParam ? 1 : 0) + (onlyElevated ? 1 : 0) + (query ? 1 : 0);

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="All workspaces"
        title="Activity log"
        lede="What's happened across every workspace, newest first."
        count={loading ? undefined : filtered.length}
        action={
          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => setParam("q", e.target.value || null)}
              placeholder="Search…"
              className="w-[200px] border border-line-2 bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              data-active={onlyElevated}
              onClick={() => setParam("elevated", onlyElevated ? null : "1")}
              className={
                "border px-3 py-1.5 text-sm transition-colors " +
                (onlyElevated
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-line bg-surface-2 text-ink-2 hover:bg-hover hover:text-ink")
              }
              title="Only show actions taken under super-admin privilege"
            >
              Super-admin only
            </button>
          </div>
        }
      />

      <form onSubmit={handleTenantSubmit} className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
          Workspace
        </span>
        <input
          className="w-[260px] border border-line-2 bg-surface px-3 py-1.5 font-mono text-xs text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
          value={tenantInput}
          onChange={(e) => setTenantInput(e.target.value)}
          placeholder="All workspaces — filter by tenant ID…"
        />
        <button
          type="submit"
          className="border border-line bg-surface-2 px-3 py-1.5 text-sm text-ink-2 transition-colors hover:bg-hover hover:text-ink"
        >
          Apply
        </button>
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={() => {
              setTenantInput("");
              const next = new URLSearchParams();
              setParams(next, { replace: true });
            }}
            className="px-3 py-1.5 text-sm text-ink-3 transition-colors hover:text-ink"
          >
            Clear all ({activeFilterCount})
          </button>
        )}
      </form>

      {eventTypes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip label="All events" count={rows.length} active={!typeParam} onClick={() => setParam("type", null)} />
          {eventTypes.map((t) => {
            const count = rows.filter((r) => r.action === t).length;
            const active = typeParam === t;
            return (
              <Chip
                key={t}
                label={t}
                mono
                count={count}
                active={active}
                onClick={() => setParam("type", active ? null : t)}
              />
            );
          })}
        </div>
      )}

      <div className="zz-rise" style={{ animationDelay: "80ms" }}>
        {loading ? (
          <SkeletonList rows={6} columns={[28, "minmax(0,1fr)", 80]} />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No matching activity"
            body={
              rows.length === 0
                ? "Once workspaces start generating events, they'll appear here."
                : "Adjust the filters above to find what you're looking for."
            }
          />
        ) : (
          <AuditTimeline
            rows={filtered}
            renderActorBadge={(row) => {
              const meta = row.metadata as { actor_super_admin?: boolean } | null | undefined;
              if (meta?.actor_super_admin !== true) return null;
              return (
                <span
                  className="ml-1 inline-flex items-center border px-1.5 py-px font-mono text-[9px] uppercase tracking-widest"
                  style={{
                    borderColor: "color-mix(in srgb, var(--tint-violet) 50%, transparent)",
                    color: "var(--tint-violet)",
                    background: "color-mix(in srgb, var(--tint-violet) 12%, transparent)",
                  }}
                >
                  Super-admin
                </span>
              );
            }}
          />
        )}
      </div>
    </div>
  );
}

function Chip({
  label,
  count,
  active,
  onClick,
  mono,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  mono?: boolean;
}) {
  return (
    <button
      type="button"
      data-active={active}
      onClick={onClick}
      className={
        "inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs transition-colors " +
        (active
          ? "border-accent bg-accent-soft text-accent"
          : "border-line bg-surface-2 text-ink-2 hover:bg-hover hover:text-ink")
      }
    >
      <span className={mono ? "font-mono text-[10.5px]" : ""}>{label}</span>
      <span className="font-mono text-[10px] tabular-nums opacity-80">{count}</span>
    </button>
  );
}
