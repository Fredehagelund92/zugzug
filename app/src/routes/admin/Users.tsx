import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../../api";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { SkeletonList } from "../../components/Skeleton";
import { toast } from "../../components/Toast";
import { readServerError } from "../../lib/api-errors";

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

export function Users() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<{ userId: string; promote: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (q?: string) => {
    setLoading(true);
    try {
      const qs = q ? `?q=${encodeURIComponent(q)}` : "";
      const r = await apiFetch(`/users${qs}`);
      if (r.ok) setUsers(((await r.json()) as { users: AdminUser[] }).users);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void load(query.trim() || undefined);
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await apiFetch(`/users/${encodeURIComponent(pending.userId)}`, {
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
      void load(query.trim() || undefined);
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
        count={loading ? undefined : users.length}
        action={
          <form onSubmit={handleSearch} className="flex gap-2">
            <input
              className="bg-surface border border-line-2 px-3 py-1.5 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
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

      <div className="zz-rise border border-line" style={{ animationDelay: "80ms" }}>
        {loading ? (
          <SkeletonList rows={5} columns={[24, "minmax(0,1fr)", 160, 80, 100, 120]} />
        ) : users.length === 0 ? (
          <EmptyState title="No users found" body="Try a different search term or invite teammates from a workspace." />
        ) : (
          <div className="border border-line divide-y divide-line bg-surface">
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
            {users.map((u, i) => (
              <div
                key={u.id}
                className="zz-rise grid grid-cols-[1fr_160px_80px_100px_120px] gap-4 items-center px-5 py-3 hover:bg-hover transition-colors"
                style={{ animationDelay: `${100 + i * 30}ms` }}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-7 w-7 shrink-0 rounded-full bg-accent-soft flex items-center justify-center">
                    <span className="font-mono text-[10px] font-bold text-accent">
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
                    <span
                      className="inline-flex items-center font-mono text-[10px] uppercase tracking-wider px-2 py-0.5"
                      style={{ color: "var(--accent-2)", background: "var(--accent-2-soft)" }}
                    >
                      admin
                    </span>
                  ) : (
                    <span className="font-mono text-[10px] text-ink-3">—</span>
                  )}
                </div>
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPending({ userId: u.id, promote: !u.isSuperAdmin })}
                  >
                    {u.isSuperAdmin ? "Demote" : "Promote"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!pending}
        title={pending?.promote ? "Promote to super-admin?" : "Remove super-admin?"}
        body={
          <p className="text-sm text-ink-2">
            {pending?.promote
              ? "This user will gain full system access including all workspaces and the admin console."
              : "This user will lose super-admin access. They retain workspace memberships."}
          </p>
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
