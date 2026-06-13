import { Link, Outlet } from "react-router-dom";
import { Mark } from "./Mark";

export function AdminShell() {
  return (
    <div className="zz-canvas min-h-screen">
      <header className="border-b border-line px-6 py-3 flex items-center gap-3">
        <Mark className="h-6 w-6" />
        <span className="font-display font-bold">Zug Zug — Admin</span>
        <nav className="ml-6 text-sm flex gap-4">
          <Link to="/app/admin/tenants">Tenants</Link>
          <Link to="/app">Back to workspaces</Link>
        </nav>
      </header>
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  );
}
