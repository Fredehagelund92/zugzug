import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { apiFetch } from "../../api";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { SkeletonList } from "../../components/Skeleton";
import { toast } from "../../components/Toast";
import { readServerError } from "../../lib/api-errors";
import { invalidate, subscribeInvalidate } from "../../store";
import { SuperAdminBadge } from "../../components/admin/SuperAdminBadge";

interface AdminUser {
  id: string;
  email: string | null;
  name: string;
  initials: string;
  isSuperAdmin: boolean;
  lastSeenAt: string | null;
  membershipCount: number;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

type RoleFilter = "all" | "super_admin" | "regular";

/** The server caps `limit` at 100; ask for one row past a page so we know
 *  whether a next page exists without a separate count query. */
const PAGE_SIZE = 50;

export function Users() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RoleFilter>("all");
  const [pending, setPending] = useState<{ user: AdminUser; promote: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const counts = useMemo(() => {
    let sa = 0;
    for (const u of users) if (u.isSuperAdmin) sa++;
    return { all: users.length, super_admin: sa, regular: users.length - sa };
  }, [users]);

  const filteredUsers = useMemo(() => {
    if (filter === "super_admin") return users.filter((u) => u.isSuperAdmin);
    if (filter === "regular") return users.filter((u) => !u.isSuperAdmin);
    return users;
  }, [users, filter]);

  const load = useCallback(async (q?: string, off = 0) => {
    setLoading(true);
    try {
      const sp = new URLSearchParams({ limit: String(PAGE_SIZE + 1), offset: String(off) });
      if (q) sp.set("q", q);
      const r = await apiFetch(`/users?${sp.toString()}`);
      if (r.ok) {
        const page = ((await r.json()) as { users: AdminUser[] }).users;
        setHasMore(page.length > PAGE_SIZE);
        setUsers(page.slice(0, PAGE_SIZE));
        setOffset(off);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  const offsetRef = useRef(offset);
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);

  useEffect(() => {
    const unsub = subscribeInvalidate("adminUsers", () => {
      void load(queryRef.current.trim() || undefined, offsetRef.current);
    });
    return unsub;
  }, [load]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void load(query.trim() || undefined, 0);
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await apiFetch(`/users/${encodeURIComponent(pending.user.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isSuperAdmin: pending.promote }),
      });
      if (r.status === 409) {
        const body = (await r.json()) as { error: string };
        if (body.error === "self_demote") {
          toast("You cannot demote yourself.", "error");
        } else if (body.error === "last_super_admin") {
          toast("Cannot demote the last super-admin.", "error");
        } else {
          toast(`Couldn't update role — ${body.error}.`, "error");
        }
        return;
      }
      if (!r.ok) {
        const msg = await readServerError(r);
        toast(`Couldn't update role — ${msg}.`, "error");
        return;
      }
      toast(pending.promote ? "Promoted to super-admin." : "Super-admin removed.", "success");
      invalidate.adminUsers();
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="System"
        title="Users"
        lede="All registered users. Promote or demote super-admin access."
        count={loading ? undefined : filteredUsers.length}
        action={
          <form onSubmit={handleSearch} className="flex gap-2">
            <input
              className="rounded-sm bg-surface border border-line-2 px-3 py-1.5 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or email…"
            />
            <Button size="sm" type="submit">
              Search
            </Button>
          </form>
        }
      />

      <div className="flex flex-wrap items-center gap-1">
        {(
          [
            { key: "all", label: "All", count: counts.all },
            { key: "super_admin", label: "Super-admins", count: counts.super_admin },
            { key: "regular", label: "Regular", count: counts.regular },
          ] as { key: RoleFilter; label: string; count: number }[]
        ).map((c) => (
          <button
            key={c.key}
            type="button"
            data-active={filter === c.key}
            onClick={() => setFilter(c.key)}
            className={
              "inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs border transition-colors " +
              (filter === c.key
                ? "bg-accent-soft border-accent text-accent"
                : "bg-surface-2 border-line text-ink-2 hover:text-ink hover:bg-hover")
            }
          >
            <span>{c.label}</span>
            <span className="font-mono text-[10px] tabular-nums opacity-80">{c.count}</span>
          </button>
        ))}
      </div>

      <Panel padding="none" className="zz-fade-in">
        {loading ? (
          <SkeletonList rows={5} columns={[24, "minmax(0,1fr)", 160, 80, 100, 120]} />
        ) : filteredUsers.length === 0 ? (
          <EmptyState
            title="No users found"
            body="Try a different search term, filter, or invite teammates from a workspace."
          />
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[760px] divide-y divide-line">
              <div className="grid grid-cols-[1fr_160px_80px_100px_120px] gap-4 items-center px-5 py-2.5">
                <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">
                  User
                </span>
                <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">
                  Last seen
                </span>
                <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3 text-right">
                  Workspaces
                </span>
                <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">
                  Role
                </span>
                <span />
              </div>
              {filteredUsers.map((u) => (
                <div
                  key={u.id}
                  className="grid grid-cols-[1fr_160px_80px_100px_120px] gap-4 items-center px-5 py-3 hover:bg-hover transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-7 w-7 shrink-0 rounded-full bg-accent flex items-center justify-center">
                      <span className="font-mono text-[10px] font-bold text-accent-ink">
                        {u.initials}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm text-ink truncate">{u.name}</div>
                      <div className="font-mono text-xs text-ink-3 truncate">{u.email ?? "—"}</div>
                    </div>
                  </div>
                  <span className="font-mono text-xs text-ink-3 tabular-nums">
                    {relativeTime(u.lastSeenAt)}
                  </span>
                  <span className="font-mono text-xs text-ink-3 tabular-nums text-right">
                    {u.membershipCount}
                  </span>
                  <div>
                    {u.isSuperAdmin ? (
                      <SuperAdminBadge />
                    ) : (
                      <span className="font-mono text-[10px] text-ink-3">—</span>
                    )}
                  </div>
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPending({ user: u, promote: !u.isSuperAdmin })}
                    >
                      {u.isSuperAdmin ? "Demote" : "Promote"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Panel>

      {(offset > 0 || hasMore) && (
        <div className="flex items-center justify-between text-xs text-ink-3">
          <span className="tabular-nums">
            Showing {users.length === 0 ? 0 : offset + 1}–{offset + users.length}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={offset === 0 || loading}
              onClick={() => void load(query.trim() || undefined, Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!hasMore || loading}
              onClick={() => void load(query.trim() || undefined, offset + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!pending}
        title={
          pending
            ? pending.promote
              ? `Grant super-admin to ${pending.user.name}?`
              : `Revoke super-admin from ${pending.user.name}?`
            : ""
        }
        body={
          pending && (
            <div className="space-y-2 text-sm text-ink-2">
              <p className="font-mono text-xs text-ink-3">{pending.user.email ?? "—"}</p>
              <p>
                {pending.promote
                  ? "This grants full system access across every workspace, including the admin console."
                  : "This removes super-admin access. The user keeps their existing workspace memberships."}
              </p>
            </div>
          )
        }
        confirmLabel={pending?.promote ? "Promote" : "Demote"}
        danger={!pending?.promote}
        onConfirm={confirm}
        onCancel={() => setPending(null)}
        loading={busy}
      />
    </div>
  );
}
