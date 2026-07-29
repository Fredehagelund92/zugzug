import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../../api";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { SkeletonList } from "../../components/Skeleton";
import { AuditTimeline } from "../../components/AuditTimeline";
import { AnchoredPopover } from "../../components/AnchoredPopover";
import type { AuditEntry } from "../../store";
import { SuperAdminBadge } from "../../components/admin/SuperAdminBadge";

const PAGE_SIZE = 30;

interface Workspace {
  id: string;
  slug: string;
  label: string;
}

export function Audit() {
  const [params, setParams] = useSearchParams();

  // URL-persisted filter state — single source of truth.
  const tenantParam = params.get("tenant") ?? "";
  const typeParam = params.get("type") ?? "";
  const onlyElevated = params.get("elevated") === "1";
  const query = params.get("q") ?? "";

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params);
      if (value && value.length > 0) next.set(key, value);
      else next.delete(key);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  /* ---- rows + keyset pagination (server-driven) ---- */
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const fetchPage = useCallback(
    async (cursor?: string): Promise<AuditEntry[]> => {
      const sp = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (tenantParam.trim()) sp.set("tenant_id", tenantParam.trim());
      if (typeParam) sp.set("type", typeParam);
      if (onlyElevated) sp.set("elevated", "1");
      if (query.trim()) sp.set("q", query.trim());
      if (cursor) sp.set("before", cursor);
      const r = await apiFetch(`/audit?${sp.toString()}`);
      if (!r.ok) return [];
      return (await r.json()) as AuditEntry[];
    },
    [tenantParam, typeParam, onlyElevated, query],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchPage().then((data) => {
      if (cancelled) return;
      setRows(data);
      setHasMore(data.length === PAGE_SIZE);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  const loadMore = async () => {
    const last = rows[rows.length - 1];
    if (!last) return;
    setLoadingMore(true);
    const data = await fetchPage(`${last.at}|${last.id}`);
    setRows((prev) => [...prev, ...data]);
    setHasMore(data.length === PAGE_SIZE);
    setLoadingMore(false);
  };

  /* ---- event types, for the picker (complete list from the server) ---- */
  const [actions, setActions] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    const qs = tenantParam.trim() ? `?tenant_id=${encodeURIComponent(tenantParam.trim())}` : "";
    void apiFetch(`/audit/actions${qs}`)
      .then(async (r) => {
        if (!r.ok) return;
        const data = (await r.json()) as string[];
        if (!cancelled) setActions(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tenantParam]);

  /* ---- search input, debounced into the URL ---- */
  const [qInput, setQInput] = useState(query);
  useEffect(() => setQInput(query), [query]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (qInput.trim() !== query) setParam("q", qInput.trim() || null);
    }, 300);
    return () => clearTimeout(t);
  }, [qInput, query, setParam]);

  /* ---- workspaces, for the filter dropdown (pick by name, not tenant ID) ---- */
  const [tenants, setTenants] = useState<Workspace[]>([]);
  useEffect(() => {
    let cancelled = false;
    void apiFetch("/tenants")
      .then(async (r) => {
        if (!r.ok) return;
        const data = (await r.json()) as { tenants: Workspace[] };
        if (!cancelled) setTenants(data.tenants);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const activeFilterCount =
    (tenantParam ? 1 : 0) + (typeParam ? 1 : 0) + (onlyElevated ? 1 : 0) + (query ? 1 : 0);

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="All workspaces"
        title="Activity"
        lede="What's happened across every workspace, newest first."
        count={loading ? undefined : rows.length}
        action={
          <div className="flex items-center gap-2">
            <input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Search…"
              className="rounded-sm w-[200px] border border-line-2 bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              data-active={onlyElevated}
              onClick={() => setParam("elevated", onlyElevated ? null : "1")}
              className={
                "rounded-sm border px-3 py-1.5 text-sm transition-colors " +
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

      <div className="flex flex-wrap items-center gap-2">
        <WorkspacePicker
          tenants={tenants}
          value={tenantParam}
          onChange={(id) => setParam("tenant", id || null)}
        />

        <TypePicker
          actions={actions}
          value={typeParam}
          onChange={(a) => setParam("type", a || null)}
        />

        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={() => {
              setQInput("");
              setParams(new URLSearchParams(), { replace: true });
            }}
            className="px-3 py-1.5 text-sm text-ink-3 transition-colors hover:text-ink"
          >
            Clear all ({activeFilterCount})
          </button>
        )}
      </div>

      <div className="zz-fade-in">
        {loading ? (
          <SkeletonList rows={6} columns={[28, "minmax(0,1fr)", 80]} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No activity found"
            body={
              activeFilterCount > 0
                ? "Adjust the filters above to find what you're looking for."
                : "Once workspaces start generating events, they'll appear here."
            }
          />
        ) : (
          <>
            <AuditTimeline
              rows={rows}
              renderActorBadge={(row) => {
                const meta = row.metadata as { actor_super_admin?: boolean } | null | undefined;
                if (meta?.actor_super_admin !== true) return null;
                return <SuperAdminBadge className="ml-1" />;
              }}
            />
            {hasMore && (
              <div className="mt-6 flex justify-center">
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="rounded-sm border border-line bg-surface-2 px-4 py-1.5 text-xs text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────── event-type picker ────────────────────────── */

/* Searchable dropdown over every distinct action code (from the server, not the
   visible rows), so the list stays complete however deep the feed runs. */
function TypePicker({
  actions,
  value,
  onChange,
}: {
  actions: string[];
  value: string;
  onChange: (action: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      // The panel is portaled, so it is not inside `ref` — test it separately.
      if (ref.current?.contains(t) || pop.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const f = filter.trim().toLowerCase();
  const shown = f ? actions.filter((a) => a.toLowerCase().includes(f)) : actions;

  const pick = (a: string) => {
    onChange(a);
    setOpen(false);
    setFilter("");
  };

  return (
    <div ref={ref} className="relative">
      <button
        ref={trigger}
        type="button"
        data-active={Boolean(value)}
        onClick={() => setOpen((v) => !v)}
        className={
          "inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-xs transition-colors " +
          (value
            ? "border-accent bg-accent-soft text-accent"
            : "border-line bg-surface-2 text-ink-2 hover:bg-hover hover:text-ink")
        }
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-70">Type</span>
        <span className={value ? "font-mono text-[11px]" : ""}>{value || "All events"}</span>
        <span aria-hidden className="text-ink-3">
          ▾
        </span>
      </button>

      {open && (
        <AnchoredPopover
          anchor={trigger}
          popoverRef={pop}
          className="rounded-lg zz-rise w-[280px] border border-line bg-surface shadow-lg"
        >
          <div className="border-b border-line p-2">
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find a type…"
              className="rounded-sm w-full border border-line-2 bg-surface px-2 py-1 text-xs text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
            />
          </div>
          <ul className="max-h-64 overflow-auto py-1">
            <TypeOption label="All events" active={!value} onClick={() => pick("")} />
            {shown.map((a) => (
              <TypeOption key={a} label={a} mono active={value === a} onClick={() => pick(a)} />
            ))}
            {shown.length === 0 && (
              <li className="px-3 py-2 text-xs text-ink-3">No type matches “{filter}”.</li>
            )}
          </ul>
        </AnchoredPopover>
      )}
    </div>
  );
}

/* ────────────────────────── workspace picker ────────────────────────── */

/* Dropdown over the real workspaces so an admin filters by picking a name,
   never by pasting a tenant ID. Shares TypePicker's chip idiom; the button shows
   the workspace label while the URL still carries the tenant id. */
function WorkspacePicker({
  tenants,
  value,
  onChange,
}: {
  tenants: Workspace[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      // The panel is portaled, so it is not inside `ref` — test it separately.
      if (ref.current?.contains(t) || pop.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const f = filter.trim().toLowerCase();
  const shown = f
    ? tenants.filter((t) => t.label.toLowerCase().includes(f) || t.slug.toLowerCase().includes(f))
    : tenants;
  const selected = tenants.find((t) => t.id === value);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setFilter("");
  };

  return (
    <div ref={ref} className="relative">
      <button
        ref={trigger}
        type="button"
        data-active={Boolean(value)}
        onClick={() => setOpen((v) => !v)}
        className={
          "inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-xs transition-colors " +
          (value
            ? "border-accent bg-accent-soft text-accent"
            : "border-line bg-surface-2 text-ink-2 hover:bg-hover hover:text-ink")
        }
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-70">
          Workspace
        </span>
        <span>{selected ? selected.label : "All workspaces"}</span>
        <span aria-hidden className="text-ink-3">
          ▾
        </span>
      </button>

      {open && (
        <AnchoredPopover
          anchor={trigger}
          popoverRef={pop}
          className="rounded-lg zz-rise w-[280px] border border-line bg-surface shadow-lg"
        >
          <div className="border-b border-line p-2">
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find a workspace…"
              className="rounded-sm w-full border border-line-2 bg-surface px-2 py-1 text-xs text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
            />
          </div>
          <ul className="max-h-64 overflow-auto py-1">
            <TypeOption label="All workspaces" active={!value} onClick={() => pick("")} />
            {shown.map((t) => (
              <TypeOption
                key={t.id}
                label={t.label}
                active={value === t.id}
                onClick={() => pick(t.id)}
              />
            ))}
            {shown.length === 0 && (
              <li className="px-3 py-2 text-xs text-ink-3">No workspace matches “{filter}”.</li>
            )}
          </ul>
        </AnchoredPopover>
      )}
    </div>
  );
}

function TypeOption({
  label,
  active,
  onClick,
  mono,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  mono?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={
          "flex w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-hover " +
          (mono ? "font-mono text-[12px] " : "") +
          (active ? "bg-accent-soft text-accent" : "text-ink")
        }
      >
        {label}
      </button>
    </li>
  );
}
