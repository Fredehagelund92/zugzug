import { useMemo, useState } from "react";
import { useAudit } from "../store";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { AuditTimeline } from "../components/AuditTimeline";

export function Audit() {
  const audit = useAudit();
  const [query, setQuery] = useState("");
  const [actor, setActor] = useState<string>("");

  const actors = useMemo(() => {
    const m = new Map<string, { id: string; name: string; count: number }>();
    for (const r of audit) {
      const cur = m.get(r.user.id);
      if (cur) cur.count += 1;
      else m.set(r.user.id, { id: r.user.id, name: r.user.name, count: 1 });
    }
    return Array.from(m.values()).sort((a, b) => b.count - a.count);
  }, [audit]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return audit
      .filter((r) => !actor || r.user.id === actor)
      .filter((r) => {
        if (!q) return true;
        return (
          r.action.toLowerCase().includes(q) ||
          (r.detail ?? "").toLowerCase().includes(q) ||
          r.user.name.toLowerCase().includes(q)
        );
      })
      .slice(0, 100);
  }, [audit, query, actor]);

  return (
    <div className="mx-auto w-full max-w-[var(--wide)] p-4 md:p-8">
      <PageHeader
        kicker="Workspace"
        title="Activity"
        lede="Everything that's happened in this workspace, newest first."
        count={audit.length === 0 ? undefined : audit.length}
        action={
          <div className="flex items-center gap-2">
            <label className="relative">
              <span className="sr-only">Search activity</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search activity…"
                className="w-[240px] border border-line-2 bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
              />
            </label>
          </div>
        }
      />

      {audit.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-1.5">
          <FilterChip
            label="Everyone"
            count={audit.length}
            active={!actor}
            onClick={() => setActor("")}
          />
          {actors.map((a) => (
            <FilterChip
              key={a.id}
              label={a.name}
              count={a.count}
              active={actor === a.id}
              onClick={() => setActor(actor === a.id ? "" : a.id)}
            />
          ))}
        </div>
      )}

      <div className="mt-8">
        {audit.length === 0 ? (
          <EmptyState
            title="Nothing's happened yet"
            body="Drafts, publishes, member changes, and other workspace actions will show up here as they occur."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No matching activity"
            body="Clear the filters or search for something else."
          />
        ) : (
          <AuditTimeline rows={filtered} />
        )}
      </div>
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
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
      <span>{label}</span>
      <span className="font-mono text-[10px] tabular-nums opacity-80">{count}</span>
    </button>
  );
}
