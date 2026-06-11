import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Card } from "../components/Card";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { FormField } from "../components/FormField";
import { PageHeader } from "../components/PageHeader";
import { SegControl } from "../components/SegControl";
import { ThresholdRange } from "../components/ThresholdRange";
import { cx } from "../lib/cx";
import { useEngineerMode } from "../lib/engineer-mode";
import {
  usePreferences,
  setPreferences,
  currentUser,
  useCurrentUser,
  scanSources,
  useWorkspaceInfo,
  useAuthConfig,
  useDimensions,
  useAudit,
  listApiTokens,
  createApiToken,
  revokeApiToken,
  listTeamMembers,
  updateUserRole,
  useConnectionHealth,
  refreshConnectionHealth,
  type ApiToken,
  type CreatedApiToken,
  type TeamMember,
  type ConnectionHealth,
} from "../store";
import { warehouseSyncStatusByDim } from "./dashboard-helpers";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { toast } from "../components/Toast";

/* Every control on this page persists on change — there is no Save button. */

/* Settings — workspace, appearance (theme), the DuckDB connection, and matching
   defaults. Token-driven, squared. UI only. */

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-0">
      <div className="border-b border-line px-4 py-3 md:px-6 md:py-4">
        <div className="max-w-2xl">
          <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
          {hint && <p className="mt-0.5 text-[13px] text-ink-2">{hint}</p>}
        </div>
      </div>
      <div className="px-4 py-4 md:px-6 md:py-5">
        <div className="max-w-2xl space-y-5">{children}</div>
      </div>
    </Card>
  );
}

interface ScanStatus {
  lastScanAt: string | null;
  sourceCount: number;
  unmappedCount: number;
  lastAutoPublishAt?: string | null;
  lastAutoPublishDetail?: string | null;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function ScansSection() {
  const prefs = usePreferences();
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const r = await fetch("/api/sources/scan-status");
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      setStatus((await r.json()) as ScanStatus);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Could not reach the server.");
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const scanNow = useAsyncAction(async () => {
    try {
      const n = await scanSources();
      await loadStatus();
      toast(`Scanned ${n} value${n === 1 ? "" : "s"}.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Scan failed.", "error");
    }
  });

  const handleScheduleChange = (next: string | null) => {
    void setPreferences({
      ...prefs,
      scanSchedule: next as "15m" | "hourly" | "daily" | null,
    });
  };

  const scheduleOptions = [
    { value: null, label: "Off" },
    { value: "15m", label: "15 min" },
    { value: "hourly", label: "Hourly" },
    { value: "daily", label: "Daily" },
  ];

  return (
    <Section
      title="Scans"
      hint="How often Zug Zug checks your warehouse sources for new unmapped values."
    >
      <FormField label="Schedule">
        <SegControl
          value={prefs.scanSchedule}
          options={scheduleOptions}
          onChange={handleScheduleChange}
        />
      </FormField>

      {status && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-line bg-surface-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <span
              className={cx(
                "inline-block h-2 w-2 shrink-0 rounded-full",
                status.unmappedCount > 0
                  ? "bg-accent shadow-[0_0_6px_var(--accent)]"
                  : "bg-ok shadow-[0_0_6px_var(--ok)]",
              )}
            />
            <span className="font-mono text-[11.5px] text-ink-2">
              last scan {relativeTime(status.lastScanAt)}
              {" · "}
              {status.sourceCount} {status.sourceCount === 1 ? "source" : "sources"}
              {status.unmappedCount > 0 && (
                <span className="text-accent"> · {status.unmappedCount} unmapped</span>
              )}
            </span>
          </div>
          <Button onClick={() => void scanNow.run()} loading={scanNow.isPending}>
            Scan now
          </Button>
        </div>
      )}

      {!status && !statusError && prefs.scanSchedule && (
        <p className="font-mono text-[11px] text-ink-3">Loading scan status…</p>
      )}

      {statusError && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-danger/40 bg-danger-soft px-4 py-2.5 font-mono text-[11.5px] text-danger">
          <span>Couldn&rsquo;t load scan status — {statusError}</span>
          <Button variant="ghost" size="sm" onClick={() => void loadStatus()}>
            Retry
          </Button>
        </div>
      )}
    </Section>
  );
}

interface Member {
  email: string;
  addedBy: string;
  addedAt: string;
}

type ChipStatus = "valid" | "invalid" | "inviting" | "failed";
interface Chip {
  id: string;
  email: string;
  status: ChipStatus;
  reason?: string;
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateChip(
  email: string,
  membersByEmail: Set<string>,
  prevChips: Chip[],
  allowedDomain: string | null, // null means any domain is allowed
): { ok: true } | { ok: false; reason: string } {
  if (!EMAIL_RX.test(email)) return { ok: false, reason: "Doesn't look like an email" };
  if (allowedDomain !== null && !email.endsWith(allowedDomain))
    return { ok: false, reason: `Must be a ${allowedDomain} email` };
  if (membersByEmail.has(email)) return { ok: false, reason: "Already on the team" };
  if (prevChips.some((c) => c.email === email && (c.status === "valid" || c.status === "inviting")))
    return { ok: false, reason: "Already in the list" };
  return { ok: true };
}

// — Team roster bits —————————————————————————————————————————————————————

type RoleKey = TeamMember["role"];

const ROLE_META: Record<
  RoleKey,
  { label: string; chip: string; ring: string; glyph: string; order: number }
> = {
  admin: {
    label: "admin",
    chip: "border-accent/40 bg-accent/10 text-accent",
    ring: "ring-2 ring-accent/30",
    glyph: "◼",
    order: 0,
  },
  editor: {
    label: "editor",
    chip: "border-line-2 bg-surface-2 text-ink",
    ring: "ring-1 ring-line-2",
    glyph: "◇",
    order: 1,
  },
  viewer: {
    label: "viewer",
    chip: "border-line bg-bg text-ink-3",
    ring: "ring-1 ring-line",
    glyph: "·",
    order: 2,
  },
};

function userInitials(name: string, email?: string | null): string {
  const base = (name || email || "?").trim();
  const parts = base.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
  }
  // Single token (likely email): first two non-symbol chars
  const clean = parts[0]!.replace(/[^a-zA-Z0-9]/g, "");
  return (clean.slice(0, 2) || "??").toUpperCase();
}

function RolePopover({
  current,
  pending,
  onPick,
  onClose,
}: {
  current: RoleKey;
  pending: boolean;
  onPick: (role: RoleKey) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className="zz-pop-in absolute right-0 top-[calc(100%+4px)] z-20 min-w-[10rem] overflow-hidden rounded-sm border border-line-2 bg-surface-elevated shadow-[0_18px_40px_-12px_rgba(0,0,0,0.35)]"
    >
      {(Object.keys(ROLE_META) as RoleKey[]).map((r) => {
        const meta = ROLE_META[r];
        const active = r === current;
        return (
          <button
            key={r}
            type="button"
            disabled={pending || active}
            onClick={() => {
              onPick(r);
              onClose();
            }}
            className={cx(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11.5px] transition-colors",
              active
                ? "cursor-default bg-surface-2 text-ink"
                : "text-ink-2 hover:bg-hover hover:text-ink",
            )}
          >
            <span aria-hidden className="w-3 text-center text-ink-3">
              {meta.glyph}
            </span>
            <span className="flex-1">{meta.label}</span>
            {active && <span className="text-[10px] text-ink-3">current</span>}
          </button>
        );
      })}
    </div>
  );
}

function MemberRoleControl({
  member,
  isAdmin,
  pending,
  onChange,
}: {
  member: TeamMember;
  isAdmin: boolean;
  pending: boolean;
  onChange: (role: RoleKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = ROLE_META[member.role];

  if (!isAdmin) {
    return (
      <span
        className={cx(
          "shrink-0 rounded-sm border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wide",
          meta.chip,
        )}
      >
        <span aria-hidden className="mr-1 opacity-70">
          {meta.glyph}
        </span>
        {meta.label}
      </span>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        disabled={pending}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cx(
          "shrink-0 inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wide transition-colors",
          meta.chip,
          "hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
          pending && "opacity-60",
        )}
      >
        <span aria-hidden className="opacity-70">
          {meta.glyph}
        </span>
        <span>{meta.label}</span>
        <svg viewBox="0 0 8 6" className="h-1.5 w-2 opacity-70" aria-hidden>
          <path d="M0 1 L4 5 L8 1" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      </button>
      {open && (
        <RolePopover
          current={member.role}
          pending={pending}
          onPick={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function MemberRow({
  member,
  isAdmin,
  isMe,
  pending,
  onRoleChange,
}: {
  member: TeamMember;
  isAdmin: boolean;
  isMe: boolean;
  pending: boolean;
  onRoleChange: (role: RoleKey) => void;
}) {
  return (
    <div className="group/row flex items-center gap-3 px-3 py-2 transition-colors hover:bg-hover/60">
      <span
        className={cx(
          "grid h-7 w-7 shrink-0 place-items-center rounded-pill bg-surface-3 font-mono text-[10px] text-ink-2",
          ROLE_META[member.role].ring,
        )}
        aria-hidden
      >
        {userInitials(member.name, member.email)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[12.5px] font-medium text-ink">
            {member.name}
          </span>
          {isMe && (
            <span className="shrink-0 rounded-sm border border-line bg-bg px-1 font-mono text-[9.5px] uppercase tracking-wider text-ink-3">
              you
            </span>
          )}
        </div>
        <div className="truncate font-mono text-[10.5px] text-ink-3">
          {member.email ?? "—"}
        </div>
      </div>
      <MemberRoleControl
        member={member}
        isAdmin={isAdmin}
        pending={pending}
        onChange={onRoleChange}
      />
    </div>
  );
}

function TeamRoster({
  users,
  isAdmin,
  currentEmail,
  rolePending,
  onRoleChange,
}: {
  users: TeamMember[];
  isAdmin: boolean;
  currentEmail: string;
  rolePending: Set<string>;
  onRoleChange: (userId: string, role: RoleKey) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | RoleKey>("all");
  const searchRef = useRef<HTMLInputElement>(null);

  const counts = useMemo(() => {
    const c = { admin: 0, editor: 0, viewer: 0 };
    for (const u of users) c[u.role]++;
    return c;
  }, [users]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (filter !== "all" && u.role !== filter) return false;
      if (!q) return true;
      return (
        u.name.toLowerCase().includes(q) ||
        (u.email ?? "").toLowerCase().includes(q) ||
        u.role.includes(q)
      );
    });
  }, [users, query, filter]);

  const bucketed = useMemo(() => {
    const groups: Record<RoleKey, TeamMember[]> = { admin: [], editor: [], viewer: [] };
    for (const u of filtered) groups[u.role].push(u);
    for (const k of Object.keys(groups) as RoleKey[]) {
      groups[k].sort((a, b) => a.name.localeCompare(b.name));
    }
    return groups;
  }, [filtered]);

  const showBuckets = filter === "all" && !query;
  const total = users.length;
  const visible = filtered.length;

  return (
    <div className="space-y-2.5">
      {/* Section sub-header: title + count */}
      <div className="flex items-baseline justify-between">
        <h3 className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-3">
          Members <span className="text-ink-3/60">·</span> roles
        </h3>
        <span className="font-mono text-[10.5px] tabular-nums text-ink-3">
          {visible === total ? (
            <>{total} total</>
          ) : (
            <>
              <span className="text-ink-2">{visible}</span>
              <span className="text-ink-3/60"> / </span>
              {total}
            </>
          )}
        </span>
      </div>

      {/* Search + role filter chips */}
      <div className="space-y-2">
        <div className="relative">
          <svg
            viewBox="0 0 16 16"
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3"
          >
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M11 11 L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name, email, or role…"
            className="w-full rounded-sm border border-line-2 bg-bg py-1.5 pl-8 pr-16 font-mono text-[12px] text-ink placeholder:text-ink-3 outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-3 hover:bg-hover hover:text-ink"
            >
              clear
            </button>
          ) : (
            <span
              className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 hidden rounded-sm border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-ink-3 sm:inline"
              aria-hidden
            >
              ⌘ K
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-1">
          <RoleFilterPill
            label="all"
            count={total}
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
          {(["admin", "editor", "viewer"] as RoleKey[]).map((r) => (
            <RoleFilterPill
              key={r}
              label={r}
              glyph={ROLE_META[r].glyph}
              count={counts[r]}
              active={filter === r}
              onClick={() => setFilter(filter === r ? "all" : r)}
            />
          ))}
        </div>
      </div>

      {/* Roster body */}
      {visible === 0 ? (
        <div className="rounded-sm border border-dashed border-line py-8 text-center font-mono text-[11.5px] text-ink-3">
          no matches{query && (
            <>
              {" "}for{" "}
              <code className="rounded-sm bg-surface-2 px-1 py-0.5 text-ink-2">
                {query}
              </code>
            </>
          )}
          {(query || filter !== "all") && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
                className="rounded-sm border border-line bg-bg px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-wider text-ink-2 hover:bg-hover"
              >
                reset
              </button>
            </div>
          )}
        </div>
      ) : showBuckets ? (
        <div className="overflow-hidden rounded-sm border border-line">
          {(["admin", "editor", "viewer"] as RoleKey[])
            .filter((r) => bucketed[r].length > 0)
            .map((r, i) => (
              <div key={r} className={cx(i > 0 && "border-t border-line")}>
                <div className="sticky top-0 z-10 flex items-baseline justify-between bg-surface-2 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-3">
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden className="opacity-60">
                      {ROLE_META[r].glyph}
                    </span>
                    {r}
                  </span>
                  <span className="tabular-nums">{bucketed[r].length}</span>
                </div>
                <div className="divide-y divide-line/70">
                  {bucketed[r].map((u) => (
                    <MemberRow
                      key={u.id}
                      member={u}
                      isAdmin={isAdmin}
                      isMe={u.email === currentEmail}
                      pending={rolePending.has(u.id)}
                      onRoleChange={(role) => onRoleChange(u.id, role)}
                    />
                  ))}
                </div>
              </div>
            ))}
        </div>
      ) : (
        <div className="overflow-hidden divide-y divide-line/70 rounded-sm border border-line">
          {filtered
            .slice()
            .sort((a, b) => {
              const ro = ROLE_META[a.role].order - ROLE_META[b.role].order;
              if (ro !== 0) return ro;
              return a.name.localeCompare(b.name);
            })
            .map((u) => (
              <MemberRow
                key={u.id}
                member={u}
                isAdmin={isAdmin}
                isMe={u.email === currentEmail}
                pending={rolePending.has(u.id)}
                onRoleChange={(role) => onRoleChange(u.id, role)}
              />
            ))}
        </div>
      )}
    </div>
  );
}

function RoleFilterPill({
  label,
  count,
  active,
  glyph,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  glyph?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-wider transition-colors",
        active
          ? "border-accent/50 bg-accent/10 text-accent"
          : "border-line bg-bg text-ink-3 hover:border-line-2 hover:text-ink-2",
      )}
    >
      {glyph && (
        <span aria-hidden className="opacity-70">
          {glyph}
        </span>
      )}
      <span>{label}</span>
      <span
        className={cx(
          "rounded-sm px-1 tabular-nums",
          active ? "bg-accent/15 text-accent" : "bg-surface-2 text-ink-3",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function AllowedEmailsList({
  members,
  loaded,
  loadError,
  onRetry,
  myEmail,
  onRemove,
}: {
  members: Member[];
  loaded: boolean;
  loadError: string | null;
  onRetry: () => void;
  myEmail: string;
  onRemove: (email: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-sm border border-line">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-hover/60"
      >
        <div className="min-w-0">
          <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2">
            Email allowlist
          </div>
          <div className="mt-0.5 text-[11.5px] text-ink-3">
            Addresses cleared to sign in. People sign in here and become members above.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] tabular-nums text-ink-3">
            {members.length}
          </span>
          <svg
            viewBox="0 0 8 6"
            className={cx(
              "h-2 w-2.5 text-ink-3 transition-transform",
              open && "rotate-180",
            )}
            aria-hidden
          >
            <path d="M0 1 L4 5 L8 1" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </div>
      </button>
      {open && (
        <div className="border-t border-line">
          {loadError && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-danger-soft px-3 py-2 font-mono text-[11px] text-danger">
              <span>Couldn&rsquo;t load — {loadError}</span>
              <Button variant="ghost" size="sm" onClick={onRetry}>
                Retry
              </Button>
            </div>
          )}
          {loaded && members.length === 0 ? (
            <div className="px-3 py-3 font-mono text-[11.5px] text-ink-3">
              The allowlist is empty.
            </div>
          ) : (
            <ul className="divide-y divide-line/70">
              {members.map((m) => (
                <li
                  key={m.email}
                  className="flex items-center gap-3 px-3 py-1.5 transition-colors hover:bg-hover/60"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2">
                    {m.email}
                  </span>
                  <span className="hidden shrink-0 font-mono text-[10px] uppercase tracking-wider text-ink-3 sm:inline">
                    by {m.addedBy === "bootstrap" ? "bootstrap" : m.addedBy}
                  </span>
                  {m.email !== myEmail && (
                    <button
                      type="button"
                      onClick={() => onRemove(m.email)}
                      className="shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wider text-ink-3 hover:bg-warn/10 hover:text-warn focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ChipPill({ chip, onRemove }: { chip: Chip; onRemove: () => void }) {
  const tone =
    chip.status === "valid"
      ? "border-line-2 bg-surface-2 text-ink"
      : chip.status === "inviting"
        ? "border-accent/40 bg-accent-wash text-accent"
        : chip.status === "invalid"
          ? "border-warn/40 bg-warn-soft text-warn"
          : "border-danger/40 bg-danger-soft text-danger";
  return (
    <span
      className={cx(
        "zz-pop-in inline-flex max-w-full items-center gap-1.5 rounded-sm border px-2 py-1 font-mono text-[11.5px] transition-colors",
        tone,
      )}
      title={chip.reason}
    >
      {chip.status === "inviting" && (
        <svg
          className="h-3 w-3 shrink-0 animate-spin"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
          <path
            d="M14 8a6 6 0 0 0-6-6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )}
      <span className="min-w-0 max-w-[240px] truncate">{chip.email}</span>
      {chip.status !== "inviting" && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove ${chip.email}`}
          className="-mr-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-pill opacity-70 transition-opacity hover:bg-current/15 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current/40"
        >
          <svg
            viewBox="0 0 12 12"
            className="h-2.5 w-2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M3 3 L9 9 M9 3 L3 9" />
          </svg>
        </button>
      )}
    </span>
  );
}

function TeamSection() {
  const authConfig = useAuthConfig();
  const currentUserData = useCurrentUser();
  const isAdmin = currentUserData?.role === "admin";
  const allowedDomain = authConfig?.allowedDomain ? "@" + authConfig.allowedDomain : null;
  const [members, setMembers] = useState<Member[]>([]);
  const [teamUsers, setTeamUsers] = useState<TeamMember[]>([]);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [chips, setChips] = useState<Chip[]>([]);
  const [buffer, setBuffer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [rolePending, setRolePending] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const idCounter = useRef(0);
  const newId = () => `c${idCounter.current++}`;

  const loadTeamUsers = useCallback(async () => {
    try {
      setTeamUsers(await listTeamMembers());
    } catch {
      // non-critical — role table is supplementary
    }
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await fetch("/api/team/members");
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      setMembers((await r.json()) as Member[]);
      setLoaded(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not reach the server.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadTeamUsers();
  }, [loadTeamUsers]);

  const handleRoleChange = async (userId: string, newRole: TeamMember["role"]) => {
    setRoleError(null);
    setRolePending((prev) => {
      const next = new Set(prev);
      next.add(userId);
      return next;
    });
    try {
      await updateUserRole(userId, newRole);
      void loadTeamUsers();
    } catch (err) {
      setRoleError(err instanceof Error ? err.message : "Could not change role.");
    } finally {
      setRolePending((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    }
  };

  const membersByEmail = useMemo(
    () => new Set(members.map((m) => m.email.toLowerCase())),
    [members],
  );

  const addChip = useCallback(
    (raw: string) => {
      const email = raw.trim().toLowerCase();
      if (!email) return;
      setChips((prev) => {
        const res = validateChip(email, membersByEmail, prev, allowedDomain);
        const chip: Chip = res.ok
          ? { id: newId(), email, status: "valid" }
          : { id: newId(), email, status: "invalid", reason: res.reason };
        return [...prev, chip];
      });
    },
    [membersByEmail, allowedDomain],
  );

  const removeChip = (id: string) => setChips((prev) => prev.filter((c) => c.id !== id));

  const submit = async () => {
    let working = chips;
    if (buffer.trim()) {
      const email = buffer.trim().toLowerCase();
      const res = validateChip(email, membersByEmail, chips, allowedDomain);
      const chip: Chip = res.ok
        ? { id: newId(), email, status: "valid" }
        : { id: newId(), email, status: "invalid", reason: res.reason };
      working = [...chips, chip];
      setChips(working);
      setBuffer("");
    }
    const validChips = working.filter((c) => c.status === "valid");
    if (validChips.length === 0) return;

    const validIds = new Set(validChips.map((c) => c.id));
    setChips((prev) =>
      prev.map((c) => (validIds.has(c.id) ? { id: c.id, email: c.email, status: "inviting" } : c)),
    );
    setSubmitting(true);

    const results = await Promise.allSettled(
      validChips.map(async (c) => {
        const res = await fetch("/api/team/members", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: c.email }),
        });
        if (res.status === 409) throw new Error("Already on the team");
        if (res.status === 400)
          throw new Error(
            allowedDomain ? `Must be a ${allowedDomain} email` : "Email domain not allowed",
          );
        if (!res.ok) throw new Error("Couldn't add — try again");
        return c.id;
      }),
    );

    const failedById = new Map<string, string>();
    const succeededIds = new Set<string>();
    validChips.forEach((c, i) => {
      const r = results[i];
      if (r.status === "fulfilled") succeededIds.add(c.id);
      else failedById.set(c.id, r.reason instanceof Error ? r.reason.message : "Failed");
    });
    setChips((prev) =>
      prev.flatMap((c) => {
        if (succeededIds.has(c.id)) return [];
        const failedReason = failedById.get(c.id);
        if (failedReason)
          return [{ id: c.id, email: c.email, status: "failed", reason: failedReason }];
        return [c];
      }),
    );
    setSubmitting(false);
    void load();
    inputRef.current?.focus();
  };

  const remove = async (email: string) => {
    setRemoveError(null);
    try {
      const res = await fetch(`/api/team/members/${encodeURIComponent(email)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setRemoveError(`Couldn't remove ${email} — ${res.status} ${res.statusText}`);
        return;
      }
      void load();
    } catch (err) {
      setRemoveError(
        err instanceof Error
          ? `Couldn't remove ${email} — ${err.message}`
          : `Couldn't remove ${email}.`,
      );
    }
  };

  const myEmail = currentUser.email;
  const validCount = chips.filter((c) => c.status === "valid").length;
  const invalidCount = chips.filter((c) => c.status === "invalid").length;
  const failedCount = chips.filter((c) => c.status === "failed").length;

  return (
    <Section
      title="Team"
      hint="Only people on this list can log in. Any team member can add or remove others."
    >
      {/* Team members with roles — searchable, role-bucketed roster */}
      {teamUsers.length > 0 && (
        <div className="space-y-2">
          {roleError && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-danger/40 bg-danger-soft px-4 py-2.5 font-mono text-[11.5px] text-danger">
              <span>{roleError}</span>
              <Button variant="ghost" size="sm" onClick={() => setRoleError(null)}>
                Dismiss
              </Button>
            </div>
          )}
          <TeamRoster
            users={teamUsers}
            isAdmin={isAdmin}
            currentEmail={myEmail ?? ""}
            rolePending={rolePending}
            onRoleChange={(userId, role) => void handleRoleChange(userId, role)}
          />
        </div>
      )}

      {/* Allowed-emails — collapsed by default; secondary to the roster above */}
      <AllowedEmailsList
        members={members}
        loaded={loaded}
        loadError={loadError}
        onRetry={() => void load()}
        myEmail={myEmail ?? ""}
        onRemove={(email) => setRemoveTarget(email)}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        title="Remove this member?"
        body={
          <>
            <code className="rounded-sm bg-surface-2 px-1 font-mono text-[12px]">
              {removeTarget}
            </code>{" "}
            will lose access immediately. They can be re-invited from this screen if needed.
          </>
        }
        confirmLabel="Remove"
        danger
        onConfirm={async () => {
          if (!removeTarget) return;
          await remove(removeTarget);
          setRemoveTarget(null);
        }}
        onCancel={() => setRemoveTarget(null)}
      />

      <div className="space-y-2">
        <div
          className={cx(
            "flex min-h-[42px] flex-wrap items-center gap-1.5 rounded-sm border border-line-2 bg-bg px-2 py-1.5 transition-colors",
            "focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/40",
            submitting && "opacity-70",
          )}
          onClick={() => inputRef.current?.focus()}
        >
          {chips.map((c) => (
            <ChipPill key={c.id} chip={c} onRemove={() => removeChip(c.id)} />
          ))}
          <input
            ref={inputRef}
            className="min-w-[160px] flex-1 bg-transparent font-mono text-[13px] text-ink outline-none placeholder:text-ink-3"
            placeholder={
              chips.length === 0
                ? allowedDomain
                  ? `colleague@${allowedDomain.slice(1)}, another@${allowedDomain.slice(1)}…`
                  : "colleague@example.com, another@example.com…"
                : ""
            }
            value={buffer}
            onChange={(e) => {
              const v = e.target.value;
              if (/[,;\n\t]/.test(v)) {
                v.split(/[,;\n\t]+/)
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .forEach(addChip);
                setBuffer("");
              } else {
                setBuffer(v);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (buffer.trim()) {
                  addChip(buffer);
                  setBuffer("");
                } else if (validCount > 0) {
                  void submit();
                }
              } else if (e.key === "Tab" && buffer.trim()) {
                addChip(buffer);
                setBuffer("");
              } else if (e.key === "Backspace" && !buffer && chips.length > 0) {
                e.preventDefault();
                removeChip(chips[chips.length - 1].id);
              }
            }}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (/[\s,;]/.test(text)) {
                e.preventDefault();
                text
                  .split(/[\s,;]+/)
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .forEach(addChip);
                setBuffer("");
              }
            }}
            onBlur={() => {
              if (buffer.trim()) {
                addChip(buffer);
                setBuffer("");
              }
            }}
            disabled={submitting}
            aria-label="Invite team members"
          />
        </div>

        <div className="flex items-center justify-between gap-3 font-mono text-[11px]">
          {chips.length === 0 ? (
            <p className="text-ink-3">
              Type or paste emails — separate with commas. Press Enter to add.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {validCount > 0 && (
                <span className="text-ink-2">
                  <span className="tabular-nums text-ink">{validCount}</span> ready
                </span>
              )}
              {invalidCount > 0 && (
                <span className="text-warn">
                  <span className="tabular-nums">{invalidCount}</span> invalid
                </span>
              )}
              {failedCount > 0 && (
                <span className="text-danger">
                  <span className="tabular-nums">{failedCount}</span> failed
                </span>
              )}
            </div>
          )}
          {chips.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setChips([]);
                setBuffer("");
                inputRef.current?.focus();
              }}
              disabled={submitting}
              className="shrink-0 text-ink-3 transition-colors hover:text-warn disabled:opacity-50"
            >
              clear all
            </button>
          )}
        </div>

        <div className="flex justify-end">
          <Button
            onClick={() => void submit()}
            disabled={submitting || (validCount === 0 && !buffer.trim())}
            className="max-md:w-full max-md:justify-center"
          >
            {submitting ? "Adding…" : validCount > 1 ? `Add ${validCount} members` : "Add"}
          </Button>
        </div>
      </div>

      {removeError && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-danger/40 bg-danger-soft px-4 py-2.5 font-mono text-[11.5px] text-danger">
          <span>{removeError}</span>
          <Button variant="ghost" size="sm" onClick={() => setRemoveError(null)}>
            Dismiss
          </Button>
        </div>
      )}
    </Section>
  );
}

function formatDate(iso: string): string {
  return iso.slice(0, 10); // "2026-06-09"
}

export function ApiTokensSection() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<CreatedApiToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await listApiTokens();
      setTokens(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load tokens.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const tok = await createApiToken(newName.trim());
      setCreatedToken(tok);
      setShowForm(false);
      setNewName("");
      void load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create token.");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await revokeApiToken(id);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke token.");
    }
  };

  const handleCopy = () => {
    if (!createdToken) return;
    void navigator.clipboard.writeText(createdToken.value);
    setCopied(true);
  };

  return (
    <Section
      title="API tokens"
      hint="Personal access tokens for headless access (dbt, CI). Each token authenticates as you. Revoke to invalidate."
    >
      {error && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-danger/40 bg-danger-soft px-4 py-2.5 font-mono text-[11.5px] text-danger">
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={() => setError(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {createdToken && (
        <div className="rounded-sm border border-warn/40 bg-warn-soft px-4 py-3">
          <p className="mb-2 text-[13px] font-semibold text-warn">
            Copy this token now — it won&rsquo;t be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-sm border border-warn/30 bg-bg px-3 py-1.5 font-mono text-[12px] text-ink">
              {createdToken.value}
            </code>
            <Button size="sm" onClick={handleCopy}>
              {copied ? "Copied!" : "Copy"}
            </Button>
          </div>
          <div className="mt-2 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCreatedToken(null);
                setCopied(false);
              }}
            >
              Done
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="font-mono text-[11px] text-ink-3">Loading tokens…</p>
      ) : (
        <ul className="divide-y divide-line rounded-sm border border-line">
          {tokens.length === 0 && !showForm && (
            <li className="px-4 py-3 text-[13px] text-ink-3">No tokens yet.</li>
          )}
          {tokens.map((tok) => (
            <li key={tok.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
                {tok.name}
              </span>
              <span className="hidden shrink-0 text-[11px] text-ink-3 sm:inline">
                created {formatDate(tok.created_at)}
              </span>
              <span className="shrink-0 text-[11px] text-ink-3">
                {tok.last_used_at ? `used ${formatDate(tok.last_used_at)}` : "never used"}
              </span>
              <button
                type="button"
                onClick={() => setRevokeTarget({ id: tok.id, name: tok.name })}
                className="shrink-0 rounded-sm text-[11px] text-ink-3 transition-colors hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      {showForm && (
        <div className="flex items-center gap-2">
          <input
            className="flex-1 rounded-sm border border-line-2 bg-bg px-3 py-1.5 font-mono text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent focus:ring-2 focus:ring-accent/40"
            placeholder="Token name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreate();
              if (e.key === "Escape") {
                setShowForm(false);
                setNewName("");
              }
            }}
            autoFocus
            disabled={creating}
          />
          <Button onClick={() => void handleCreate()} loading={creating} disabled={!newName.trim()}>
            Generate
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setShowForm(false);
              setNewName("");
              setCreateError(null);
            }}
            disabled={creating}
          >
            Cancel
          </Button>
        </div>
      )}

      {createError && (
        <div className="rounded-sm border border-danger/40 bg-danger-soft px-4 py-2.5 font-mono text-[11.5px] text-danger">
          {createError}
        </div>
      )}

      {!showForm && (
        <div className="flex justify-end">
          <Button onClick={() => setShowForm(true)}>Create token</Button>
        </div>
      )}

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke this token?"
        body={
          revokeTarget && (
            <>
              Token{" "}
              <code className="rounded-sm bg-surface-2 px-1 font-mono text-[12px]">
                {revokeTarget.name}
              </code>{" "}
              will stop working immediately. Anything using it (dbt, CI, scripts) will break until
              you generate a new one.
            </>
          )
        }
        confirmLabel="Revoke"
        danger
        onConfirm={async () => {
          if (!revokeTarget) return;
          await handleRevoke(revokeTarget.id);
          setRevokeTarget(null);
        }}
        onCancel={() => setRevokeTarget(null)}
      />
    </Section>
  );
}

function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function HealthBadge({ state }: { state?: ConnectionHealth["warehouse"] }) {
  if (!state) {
    return <Badge dot>checking…</Badge>;
  }
  if (state.status === "disabled") {
    return <Badge dot>disabled</Badge>;
  }
  if (state.status === "error") {
    return (
      <span title={state.error}>
        <Badge tone="warn" dot>
          error · {ago(state.lastCheckedAt)}
        </Badge>
      </span>
    );
  }
  return (
    <Badge tone="ok" dot>
      ok · {ago(state.lastCheckedAt)}
    </Badge>
  );
}

export function Settings() {
  const { engineer, setEngineer } = useEngineerMode();
  const prefs = usePreferences();
  const wsInfo = useWorkspaceInfo();
  const dims = useDimensions();
  const audit = useAudit();
  const failedSyncCount = useMemo(() => {
    if (!wsInfo?.writable || dims.length === 0) return 0;
    const status = warehouseSyncStatusByDim(audit, dims);
    return Object.values(status).filter((s) => s === "failed").length;
  }, [wsInfo?.writable, dims, audit]);
  const adapterLabel = wsInfo ? wsInfo.adapter[0]?.toUpperCase() + wsInfo.adapter.slice(1) : "…";
  const health = useConnectionHealth();
  const refreshHealth = useAsyncAction(async () => {
    await refreshConnectionHealth({ force: true });
  });

  return (
    <div className="mx-auto w-full max-w-[var(--wide)] space-y-4 p-4 md:space-y-6 md:p-8">
      <PageHeader kicker="Workspace" title="Settings" lede="Changes are saved as you make them." />

      <div className="zz-rise" style={{ animationDelay: "60ms" }}>
        <ScansSection />
      </div>

      <div className="zz-rise" style={{ animationDelay: "100ms" }}>
        <Section title="Appearance" hint="Theme follows the toggle in the top bar.">
          <FormField label="Engineer details">
            <div className="flex items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={engineer}
                aria-label="Engineer details"
                onClick={() => setEngineer(!engineer)}
                className={cx("ak-toggle", engineer && "on")}
              />
              <span className="text-[13px] text-ink-2">
                Show warehouse table names, SQL, and join warnings
              </span>
            </div>
          </FormField>
        </Section>
      </div>

      <div className="zz-rise" style={{ animationDelay: "140ms" }}>
        <Section
          title="Connections"
          hint={
            engineer
              ? `Reads source values from your warehouse (${adapterLabel}); master records live where the adapter's writability allows; team state lives in Postgres.`
              : "Where Zug Zug reads from and where your work is kept."
          }
        >
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              loading={refreshHealth.isPending}
              onClick={() => void refreshHealth.run()}
            >
              Refresh
            </Button>
          </div>

          {/* Warehouse — where source values come from */}
          <div className="rounded-sm border border-line bg-surface-2 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="font-display text-[14px] font-semibold text-ink">Warehouse</span>
                <Badge>{adapterLabel}</Badge>
              </div>
              <HealthBadge state={health?.warehouse} />
            </div>
            {engineer ? (
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-2">
                {wsInfo?.warehouseDb && (
                  <>
                    <span>{wsInfo.warehouseDb}</span>
                    <span>·</span>
                  </>
                )}
                <span>
                  {wsInfo?.writable
                    ? "scanned for source values & writes canonical via MERGE"
                    : "scanned for source values — never written to"}
                </span>
              </div>
            ) : (
              <div className="mt-1 text-[12.5px] text-ink-2">
                Where Zug Zug looks for new values that need a master record.
              </div>
            )}
          </div>

          {/* Master records — where the cleaned-up records get committed */}
          <div className="rounded-sm border border-line bg-surface-2 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="font-display text-[14px] font-semibold text-ink">
                  Master records
                </span>
                <Badge tone={wsInfo?.writable ? "ok" : undefined}>
                  {wsInfo
                    ? wsInfo.writable
                      ? `Saved to ${adapterLabel}`
                      : "Kept in this workspace"
                    : "…"}
                </Badge>
              </div>
              {failedSyncCount > 0 ? (
                <Badge tone="warn" dot>
                  {failedSyncCount} not yet saved to warehouse
                </Badge>
              ) : wsInfo?.writable ? (
                <Badge tone="ok" dot>
                  in sync
                </Badge>
              ) : (
                <Badge dot>downloadable</Badge>
              )}
            </div>
            {engineer ? (
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-2">
                <span>
                  {wsInfo?.writable
                    ? `dim_* / map_* committed to ${wsInfo.warehouseDb ?? "warehouse"} via MERGE INTO`
                    : "dim_* / map_* live in Postgres; download Parquet on demand"}
                </span>
              </div>
            ) : (
              <div className="mt-1 text-[12.5px] text-ink-2">
                {wsInfo?.writable
                  ? "Each commit also writes the master records back to your warehouse."
                  : "Each commit stays in this workspace. Download a snapshot from any table to ship the records elsewhere (e.g. to dbt)."}
              </div>
            )}
          </div>

          {/* App — the collaborative layer (drafts, history, team) */}
          <div className="rounded-sm border border-line bg-surface-2 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="font-display text-[14px] font-semibold text-ink">App</span>
                <Badge tone="accent">Postgres</Badge>
              </div>
              <HealthBadge state={health?.postgres} />
            </div>
            {engineer ? (
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-2">
                <span>drafts · audit log · users · sessions · preferences</span>
              </div>
            ) : (
              <div className="mt-1 text-[12.5px] text-ink-2">
                Drafts, history, and your team — the collaborative layer.
              </div>
            )}
          </div>
        </Section>
      </div>

      <div className="zz-rise" style={{ animationDelay: "180ms" }}>
        <Section
          title="Matching defaults"
          hint="How aggressively Zug Zug matches new values when a scan finds them."
        >
          <FormField label="Confidence bands">
            <ThresholdRange
              publish={prefs.publishThreshold}
              suggest={prefs.suggestThreshold}
              onChange={({ publish, suggest }) =>
                setPreferences({ ...prefs, publishThreshold: publish, suggestThreshold: suggest })
              }
            />
          </FormField>
        </Section>
      </div>

      <div className="zz-rise" style={{ animationDelay: "220ms" }}>
        <TeamSection />
      </div>

      <div className="zz-rise" style={{ animationDelay: "260ms" }}>
        <ApiTokensSection />
      </div>
    </div>
  );
}
