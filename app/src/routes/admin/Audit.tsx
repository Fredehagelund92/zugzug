import { useState, useEffect } from "react";
import { apiFetch } from "../../api";

export interface User {
  id: string;
  name: string;
  initials: string;
}

interface AuditEntry {
  id: string;
  at: string;
  user: User;
  action: string;
  detail: string;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function Audit() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [tenantFilter, setTenantFilter] = useState("");

  const load = async (tenantId?: string) => {
    setLoading(true);
    try {
      const qs = tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}&limit=100` : "?limit=100";
      const r = await apiFetch(`/audit${qs}`);
      if (r.ok) setRows((await r.json()) as AuditEntry[]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleFilter = (e: React.FormEvent) => {
    e.preventDefault();
    void load(tenantFilter.trim() || undefined);
  };

  return (
    <div className="space-y-6">
      <div className="zz-rise flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold mb-1.5">System audit</h1>
          <p className="text-sm text-ink-2">Cross-workspace activity log. Newest first.</p>
        </div>
        <form onSubmit={handleFilter} className="flex gap-2">
          <input
            className="bg-surface border border-line-2 px-3 py-1.5 text-sm text-ink font-mono placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
            value={tenantFilter}
            onChange={(e) => setTenantFilter(e.target.value)}
            placeholder="Filter by tenant ID…"
          />
          <button
            type="submit"
            className="px-3 py-1.5 text-sm bg-surface-2 border border-line text-ink-2 hover:text-ink hover:bg-hover transition-colors"
          >
            Filter
          </button>
          {tenantFilter && (
            <button
              type="button"
              onClick={() => {
                setTenantFilter("");
                void load();
              }}
              className="px-3 py-1.5 text-sm text-ink-3 hover:text-ink transition-colors"
            >
              Clear
            </button>
          )}
        </form>
      </div>

      <div className="zz-rise" style={{ animationDelay: "80ms" }}>
        {loading ? (
          <div className="border border-line py-16 flex items-center justify-center">
            <span className="font-mono text-xs text-ink-3 uppercase tracking-widest">Loading…</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="border border-dashed border-line-2 py-16 text-center">
            <p className="text-sm text-ink-3">No audit events found.</p>
          </div>
        ) : (
          <div className="border border-line divide-y divide-line">
            <div className="grid grid-cols-[140px_100px_160px_1fr] gap-4 items-center px-5 py-2.5 bg-surface-2">
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">
                When
              </span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">
                User
              </span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">
                Action
              </span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">
                Detail
              </span>
            </div>
            {rows.map((row, i) => (
              <div
                key={row.id ?? i}
                className="zz-rise grid grid-cols-[140px_100px_160px_1fr] gap-4 items-baseline px-5 py-3 hover:bg-hover transition-colors"
                style={{ animationDelay: `${100 + i * 20}ms` }}
              >
                <span className="font-mono text-xs text-ink-3 tabular-nums">
                  {relativeTime(row.at)}
                </span>
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full bg-accent-soft flex items-center justify-center text-[10px] font-bold text-accent">
                    {row.user.initials}
                  </div>
                  <span className="font-mono text-xs text-ink-3 truncate">{row.user.name}</span>
                </div>
                <code className="font-mono text-xs text-accent truncate">{row.action}</code>
                <span className="text-sm text-ink-2 truncate">{row.detail}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
