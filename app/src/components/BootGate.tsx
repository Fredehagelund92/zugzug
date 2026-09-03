import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { authFetch } from "../api";
import { setMemberships, useMemberships } from "../store";
import { Mark } from "./Mark";
import { Button } from "./Button";
import { NoWorkspaceLanding } from "./NoWorkspaceLanding";
import { LAST_SLUG_KEY } from "../lib/tenant-storage";
import { loginUrlWithReturnTo } from "../lib/return-to";
import type { Membership } from "./TenantLayout";

export interface BootData {
  memberships: Membership[];
  isSuperAdmin: boolean;
}

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: BootData }
  | { kind: "error"; detail: string };

/** Where "/app" lands. Reads memberships live from the store, so a leave,
 *  delete or rename that bounced the user here can never send them straight
 *  back into a workspace they no longer belong to (the old snapshot did, and
 *  the two <Navigate>s ping-ponged until React gave up). Order: the workspace
 *  last used if it is still a membership, else the first membership, else the
 *  super-admin shell, else the no-workspace landing. */
export function AppIndex({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const memberships = useMemberships();
  const last = localStorage.getItem(LAST_SLUG_KEY);
  const slug =
    memberships.find((m) => m.slug === last)?.slug ??
    memberships[0]?.slug ??
    (isSuperAdmin ? "admin" : null);
  if (!slug) return <NoWorkspaceLanding />;
  return <Navigate to={`/app/${slug}`} replace />;
}

export function BootGate({ children }: { children: (data: BootData) => ReactNode }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  const boot = () => {
    setState({ kind: "loading" });
    (async () => {
      const meRes = await authFetch("/auth/me");
      if (meRes.status === 401) {
        // Carry the page they asked for, so signing in lands them there and
        // not on the default workspace.
        window.location.replace(loginUrlWithReturnTo(window.location));
        return;
      }
      if (!meRes.ok) throw new Error(`API unreachable (${meRes.status})`);

      const memRes = await authFetch("/me/memberships");
      if (!memRes.ok) throw new Error(`memberships ${memRes.status}`);
      const body = (await memRes.json()) as BootData;

      // Seed the memberships slice. Every routing decision downstream reads it
      // live (AppIndex, TenantLayout, AppShell), so invalidate.memberships()
      // after a leave/delete/rename re-routes instead of stranding the app on
      // a boot-time snapshot. "/" and "/app" resolve through AppIndex.
      setMemberships(body.memberships);

      setState({ kind: "ready", data: body });
    })().catch((e: unknown) =>
      setState({ kind: "error", detail: e instanceof Error ? e.message : String(e) }),
    );
  };

  useEffect(boot, []);

  if (state.kind === "ready") return <>{children(state.data)}</>;

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
