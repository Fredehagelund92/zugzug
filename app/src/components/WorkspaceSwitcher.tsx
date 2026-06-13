import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTenant } from "../lib/tenant-context";
import { authFetch } from "../api";
import { useMemberships } from "../store";
import { can } from "../lib/permissions";

/** Memberships are read live from the store so a rename/leave/delete from any
 *  Settings page reflects here without a reload. */
export function WorkspaceSwitcher() {
  const tenant = useTenant();
  const memberships = useMemberships();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const switchTo = (slug: string) => {
    setOpen(false);
    if (slug === tenant.slug) return;
    // Preserve subpath where possible
    const rest = location.pathname.replace(/^\/app\/[^/]+/, "") || "";
    navigate(`/app/${slug}${rest}`);
  };

  const signOut = () =>
    authFetch("/auth/logout", { method: "POST" }).then(() => window.location.replace("/login"));

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded px-2 py-1 hover:bg-surface-2 w-full text-left"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="font-medium truncate">{tenant.label}</span>
        <span aria-hidden className="ml-auto shrink-0">
          ▾
        </span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1 min-w-[220px] rounded border border-line bg-surface shadow-lg z-50"
        >
          <div className="px-3 py-1.5 text-xs text-ink-2 uppercase tracking-wide">Workspaces</div>
          {memberships.map((m) => (
            <button
              key={m.slug}
              onClick={() => switchTo(m.slug)}
              className={`flex w-full text-left px-3 py-1.5 hover:bg-surface-2 ${m.slug === tenant.slug ? "font-medium" : ""}`}
              role="menuitem"
            >
              <span className="mr-2 inline-block w-3">{m.slug === tenant.slug ? "✓" : ""}</span>
              {m.label}
              <span className="ml-2 text-xs text-ink-2">({m.role})</span>
            </button>
          ))}
          {tenant.isSuperAdmin && (
            <>
              <hr className="my-1 border-line" />
              <button
                onClick={() => {
                  setOpen(false);
                  navigate("/app/admin");
                }}
                className="block w-full text-left px-3 py-1.5 hover:bg-surface-2"
                role="menuitem"
              >
                Admin console
              </button>
              <button
                onClick={() => {
                  setOpen(false);
                  navigate("/app/admin/tenants");
                }}
                className="block w-full text-left px-3 py-1.5 hover:bg-surface-2"
                role="menuitem"
              >
                + Create workspace
              </button>
            </>
          )}
          <hr className="my-1 border-line" />
          <button
            onClick={() => {
              setOpen(false);
              navigate(`/app/${tenant.slug}/account`);
            }}
            className="block w-full text-left px-3 py-1.5 text-sm hover:bg-surface-2 transition-colors"
            role="menuitem"
          >
            Account settings
          </button>
          {can(tenant, "settings.general.edit") && (
            <button
              onClick={() => {
                setOpen(false);
                navigate(`/app/${tenant.slug}/settings`);
              }}
              className="block w-full text-left px-3 py-1.5 text-sm hover:bg-surface-2 transition-colors"
              role="menuitem"
            >
              Workspace settings
            </button>
          )}
          <hr className="my-1 border-line" />
          <button
            onClick={signOut}
            className="block w-full text-left px-3 py-1.5 hover:bg-surface-2"
            role="menuitem"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
