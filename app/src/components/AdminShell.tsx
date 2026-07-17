import { Link, Outlet } from "react-router-dom";
import { Mark } from "./Mark";

export function AdminShell() {
  const lastTenant = sessionStorage.getItem("zz:lastTenant");
  const backTarget = lastTenant ? `/app/${lastTenant}` : "/app";
  return (
    // Fixed-height shell with the scroll confined to <main> (matching AppShell)
    // so navigating between pages of different heights never adds/removes the
    // viewport scrollbar — which otherwise shifts content sideways on click.
    // scrollbarGutter:"stable" reserves the gutter so short pages don't jump.
    <div className="zz-canvas flex h-screen flex-col overflow-hidden">
      <header className="border-b border-line px-6 py-3 flex items-center gap-3 shrink-0">
        <Mark className="h-6 w-6" />
        <span className="font-display font-bold">Zug Zug — Admin</span>
        <nav className="ml-6 text-sm flex gap-4">
          <Link to="/app/admin/tenants">Tenants</Link>
          <Link to={backTarget}>Back to workspaces</Link>
        </nav>
      </header>
      <main className="flex-1 overflow-y-auto p-6" style={{ scrollbarGutter: "stable" }}>
        <Outlet />
      </main>
    </div>
  );
}
