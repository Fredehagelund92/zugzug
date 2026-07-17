import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import type { AuditEntry } from "../store";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { PageContainer } from "../components/PageContainer";
import { AuditTimeline } from "../components/AuditTimeline";

const PAGE_SIZE = 30;

interface MemberLite {
  user_id: string;
  name: string;
  email: string;
}

export function Audit() {
  usePageTitle("Activity");
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const actor = params.get("actor") ?? "";

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params);
      if (value) next.set(key, value);
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
      if (actor) sp.set("actor", actor);
      if (query.trim()) sp.set("q", query.trim());
      if (cursor) sp.set("before", cursor);
      const r = await apiFetch(`/audit?${sp.toString()}`);
      if (!r.ok) return [];
      return (await r.json()) as AuditEntry[];
    },
    [actor, query],
  );

  // Reload the first page whenever the filter (actor or search) changes.
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

  /* ---- search input, debounced into the URL ---- */
  const [qInput, setQInput] = useState(query);
  useEffect(() => setQInput(query), [query]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (qInput.trim() !== query) setParam("q", qInput.trim() || null);
    }, 300);
    return () => clearTimeout(t);
  }, [qInput, query, setParam]);

  /* ---- workspace members, for the people picker ---- */
  const [members, setMembers] = useState<MemberLite[]>([]);
  useEffect(() => {
    let cancelled = false;
    void apiFetch("/team/members")
      .then(async (r) => {
        if (!r.ok) return;
        const data = (await r.json()) as MemberLite[];
        if (!cancelled) setMembers(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const hasFilter = Boolean(actor || query.trim());

  return (
    <PageContainer>
      <PageHeader
        kicker="This workspace"
        title="Activity"
        lede="Everything that's happened in this workspace, newest first."
        count={loading ? undefined : rows.length}
        action={
          <div className="flex items-center gap-2">
            <label className="relative">
              <span className="sr-only">Search activity</span>
              <input
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Search activity…"
                className="w-[240px] border border-line-2 bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
              />
            </label>
          </div>
        }
      />

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <PeoplePicker
          members={members}
          value={actor}
          onChange={(id) => setParam("actor", id || null)}
        />
        {hasFilter && (
          <button
            type="button"
            onClick={() => {
              setQInput("");
              setParams(new URLSearchParams(), { replace: true });
            }}
            className="px-2 py-1 text-xs text-ink-3 transition-colors hover:text-ink"
          >
            Clear
          </button>
        )}
      </div>

      <div className="mt-8">
        {loading ? (
          <div className="py-16 text-center font-mono text-xs uppercase tracking-[0.2em] text-ink-3">
            Loading…
          </div>
        ) : rows.length === 0 ? (
          hasFilter ? (
            <EmptyState
              title="No activity found"
              body="Clear the filters or search for something else."
            />
          ) : (
            <EmptyState
              title="Nothing's happened yet"
              body="Drafts, publishes, member changes, and other workspace actions will show up here as they occur."
            />
          )
        ) : (
          <>
            <AuditTimeline rows={rows} />
            {hasMore && (
              <div className="mt-6 flex justify-center">
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="border border-line bg-surface-2 px-4 py-1.5 text-xs text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </PageContainer>
  );
}

/* ────────────────────────── people picker ────────────────────────── */

/* A searchable dropdown over every workspace member — so the reader can filter
   by anyone, not just whoever happens to be in the visible rows. */
function PeoplePicker({
  members,
  value,
  onChange,
}: {
  members: MemberLite[];
  value: string;
  onChange: (userId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = members.find((m) => m.user_id === value);
  const label = value ? (selected?.name ?? "Selected person") : "Everyone";

  const f = filter.trim().toLowerCase();
  const shown = f
    ? members.filter((m) => m.name.toLowerCase().includes(f) || m.email.toLowerCase().includes(f))
    : members;

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setFilter("");
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-active={Boolean(value)}
        onClick={() => setOpen((v) => !v)}
        className={
          "inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs transition-colors " +
          (value
            ? "border-accent bg-accent-soft text-accent"
            : "border-line bg-surface-2 text-ink-2 hover:bg-hover hover:text-ink")
        }
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-70">Who</span>
        <span>{label}</span>
        <span aria-hidden className="text-ink-3">
          ▾
        </span>
      </button>

      {open && (
        <div className="zz-rise absolute left-0 z-20 mt-1 w-[260px] border border-line bg-surface shadow-lg">
          <div className="border-b border-line p-2">
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find a person…"
              className="w-full border border-line-2 bg-surface px-2 py-1 text-xs text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
            />
          </div>
          <ul className="max-h-64 overflow-auto py-1">
            <PickerOption label="Everyone" active={!value} onClick={() => pick("")} />
            {shown.map((m) => (
              <PickerOption
                key={m.user_id}
                label={m.name}
                sub={m.email}
                active={value === m.user_id}
                onClick={() => pick(m.user_id)}
              />
            ))}
            {shown.length === 0 && (
              <li className="px-3 py-2 text-xs text-ink-3">No one matches “{filter}”.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function PickerOption({
  label,
  sub,
  active,
  onClick,
}: {
  label: string;
  sub?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={
          "flex w-full flex-col items-start px-3 py-1.5 text-left transition-colors hover:bg-hover " +
          (active ? "bg-accent-soft" : "")
        }
      >
        <span className={"text-sm " + (active ? "text-accent" : "text-ink")}>{label}</span>
        {sub && <span className="font-mono text-[10px] text-ink-3">{sub}</span>}
      </button>
    </li>
  );
}
