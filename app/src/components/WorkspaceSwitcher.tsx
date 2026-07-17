import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMemberships } from "../store";
import { useTenant } from "../lib/tenant-context";
import { workspaceColor, workspaceInitials } from "../lib/workspace-colors";
import { cx } from "../lib/cx";

function WorkspaceAvatar({
  label,
  color,
  size,
}: {
  label: string;
  color: string | null;
  size: number;
}) {
  return (
    <div
      style={{
        width: size,
        height: size,
        background: workspaceColor(color),
        borderRadius: 6,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <span
        style={{ fontSize: size <= 22 ? 9 : 10, fontWeight: 700, color: "#fff", lineHeight: 1 }}
      >
        {workspaceInitials(label)}
      </span>
    </div>
  );
}

export function WorkspaceSwitcher() {
  const tenant = useTenant();
  const memberships = useMemberships();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const navigate = useNavigate();
  const location = useLocation();
  const searchRef = useRef<HTMLInputElement>(null);

  const others = memberships.filter((m) => m.slug !== tenant.slug);
  const filtered = query
    ? others.filter((m) => m.label.toLowerCase().includes(query.toLowerCase()))
    : others;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFocusedIdx(-1);
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIdx((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIdx((i) => Math.max(i - 1, -1));
      } else if (e.key === "Enter" && focusedIdx >= 0 && filtered[focusedIdx]) {
        switchTo(filtered[focusedIdx]!.slug);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, focusedIdx, filtered]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchTo = (slug: string) => {
    setOpen(false);
    if (slug === tenant.slug) return;
    const rest = location.pathname.replace(/^\/app\/[^/]+/, "") || "";
    navigate(`/app/${slug}${rest}`);
  };

  return (
    <>
      {/* ── Trigger ── */}
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded px-2 py-1 hover:bg-surface-2 w-full text-left"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <WorkspaceAvatar label={tenant.label} color={tenant.color} size={22} />
        <span className="font-medium truncate flex-1 text-sm">{tenant.label}</span>
        <span aria-hidden className="shrink-0 text-ink-3 text-[10px]">
          ▾
        </span>
      </button>

      {/* ── Modal ── */}
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
            {/* Backdrop */}
            <div
              role="presentation"
              className="absolute inset-0 bg-black/30"
              onClick={() => setOpen(false)}
            />

            {/* Panel */}
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Switch workspace"
              className="relative w-[360px] rounded-xl border border-line bg-surface shadow-2xl overflow-hidden"
            >
              {/* Search */}
              <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-line">
                <svg className="h-3.5 w-3.5 text-ink-3 shrink-0" viewBox="0 0 16 16" fill="none">
                  <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5" />
                  <path
                    d="M10.5 10.5L14 14"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setFocusedIdx(-1);
                  }}
                  placeholder="Switch workspace…"
                  className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-3 focus:outline-none"
                />
                <kbd className="font-mono text-[10px] text-ink-3 bg-surface-2 border border-line px-1.5 py-0.5 rounded">
                  ESC
                </kbd>
              </div>

              {/* Current workspace */}
              <div className="py-1">
                <div className="px-3.5 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-3">
                  Current
                </div>
                <div className="px-3.5 py-1.5 flex items-center gap-2.5 bg-hover">
                  <WorkspaceAvatar label={tenant.label} color={tenant.color} size={26} />
                  <span className="flex-1 text-sm font-medium text-ink truncate">
                    {tenant.label}
                  </span>
                  <span className="text-[10px] text-ink-3 bg-surface-2 border border-line rounded px-1.5 py-0.5 shrink-0">
                    {tenant.role}
                  </span>
                </div>
              </div>

              {/* All workspaces */}
              {filtered.length > 0 && (
                <div className="border-t border-line py-1">
                  <div className="px-3.5 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-3">
                    All workspaces
                  </div>
                  <div className="max-h-[240px] overflow-y-auto">
                    {filtered.map((m, i) => (
                      <button
                        key={m.slug}
                        onClick={() => switchTo(m.slug)}
                        className={cx(
                          "w-full flex items-center gap-2.5 px-3.5 py-1.5 text-left transition-colors",
                          focusedIdx === i ? "bg-hover" : "hover:bg-hover",
                        )}
                      >
                        <WorkspaceAvatar label={m.label} color={m.color} size={26} />
                        <span className="flex-1 text-sm text-ink truncate">{m.label}</span>
                        <span className="text-[10px] text-ink-3 bg-surface-2 border border-line rounded px-1.5 py-0.5 shrink-0">
                          {m.role}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Admin console — superAdmin only */}
              {tenant.isSuperAdmin && (
                <div
                  className="border-t"
                  style={{ borderColor: "color-mix(in srgb, var(--accent-2) 30%, var(--line))" }}
                >
                  <Link
                    to="/app/admin"
                    onClick={() => setOpen(false)}
                    className="group relative flex items-center gap-3 px-3.5 py-3 transition-all duration-150 hover:bg-accent-2-soft"
                  >
                    {/* amber left rail on hover */}
                    <div
                      className="absolute left-0 top-2.5 bottom-2.5 w-[2px] rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                      style={{ background: "var(--accent-2)" }}
                    />

                    {/* terminal icon */}
                    <div
                      className="h-7 w-7 shrink-0 rounded-md flex items-center justify-center"
                      style={{ background: "var(--accent-2-soft)", color: "var(--accent-2)" }}
                    >
                      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
                        <path
                          d="M2.5 5L6.5 8L2.5 11"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M8.5 11H13.5"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-ink-2 group-hover:text-ink transition-colors">
                        Admin console
                      </div>
                      <div className="font-mono text-[10px] text-ink-3 tracking-wide">
                        superadmin access
                      </div>
                    </div>

                    <svg
                      className="h-3 w-3 shrink-0 text-ink-3 group-hover:text-accent-2 transition-colors"
                      viewBox="0 0 16 16"
                      fill="none"
                    >
                      <path
                        d="M6 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </Link>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
