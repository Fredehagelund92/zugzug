import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { authFetch } from "../api";
import { Mark } from "./Mark";
import { Button } from "./Button";
import { NoWorkspaceLanding } from "./NoWorkspaceLanding";
import type { Membership } from "./TenantLayout";

export interface BootData {
  memberships: Membership[];
  isSuperAdmin: boolean;
}

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: BootData }
  | { kind: "no-workspace" }
  | { kind: "error"; detail: string };

const LAST_SLUG_KEY = "zugzug:last-tenant-slug";

export function BootGate({ children }: { children: (data: BootData) => ReactNode }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const navigate = useNavigate();
  const location = useLocation();

  const boot = () => {
    setState({ kind: "loading" });
    (async () => {
      const meRes = await authFetch("/auth/me");
      if (meRes.status === 401) {
        window.location.replace("/login");
        return;
      }
      if (!meRes.ok) throw new Error(`API unreachable (${meRes.status})`);

      const memRes = await authFetch("/me/memberships");
      if (!memRes.ok) throw new Error(`memberships ${memRes.status}`);
      const body = (await memRes.json()) as BootData;

      if (body.memberships.length === 0 && !body.isSuperAdmin) {
        setState({ kind: "no-workspace" });
        return;
      }

      // Redirect from / or /app to the resolved slug.
      if (location.pathname === "/" || location.pathname === "/app") {
        const last = localStorage.getItem(LAST_SLUG_KEY);
        const preferred =
          (last && body.memberships.find((m) => m.slug === last)?.slug) ??
          body.memberships[0]?.slug ??
          (body.isSuperAdmin ? "admin" : null);
        if (preferred) navigate(`/app/${preferred}`, { replace: true });
      }

      setState({ kind: "ready", data: body });
    })().catch((e: unknown) =>
      setState({ kind: "error", detail: e instanceof Error ? e.message : String(e) }),
    );
  };

  useEffect(boot, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.kind === "ready") return <>{children(state.data)}</>;
  if (state.kind === "no-workspace") return <NoWorkspaceLanding />;

  if (state.kind === "error") {
    return (
      <div className="zz-canvas grid min-h-screen place-items-center p-8">
        <div className="max-w-lg space-y-4 rounded-lg border border-line bg-surface p-8">
          <div className="flex items-center gap-2.5">
            <Mark className="h-7 w-7" />
            <span className="font-display text-lg font-extrabold tracking-tight text-ink">
              Zug Zug<span className="text-accent">.</span>
            </span>
          </div>
          <h1 className="font-display text-2xl font-bold text-ink">Can&apos;t reach the API.</h1>
          <p className="text-ink-2">The server isn&apos;t responding. Start it with:</p>
          <pre className="overflow-x-auto rounded-sm border border-line bg-bg px-3 py-2 font-mono text-[12px] text-ink-2">
            cd server &amp;&amp; bun run start
          </pre>
          <details className="text-[12px] text-ink-2">
            <summary className="cursor-pointer">Technical detail</summary>
            <pre className="mt-2 whitespace-pre-wrap font-mono">{state.detail}</pre>
          </details>
          <div className="flex justify-end">
            <Button onClick={boot}>Retry</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="zz-canvas grid min-h-screen place-items-center p-8">
      <div className="flex items-center gap-2.5">
        <Mark className="h-8 w-8 animate-pulse" />
        <span className="font-display text-lg font-extrabold tracking-tight text-ink-2">
          Loading Zug Zug<span className="text-accent">…</span>
        </span>
      </div>
    </div>
  );
}
