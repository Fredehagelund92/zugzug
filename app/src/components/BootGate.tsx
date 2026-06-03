import { useEffect, useState, type ReactNode } from "react";
import { initStore } from "../store";
import { Mark } from "./Mark";
import { Button } from "./Button";

/* BootGate — wraps the router so React mounts immediately and the async
   initStore() call shows a styled skeleton instead of a blank page (or, on
   API failure, a styled error with retry — never raw HTML in #root). */

type State = { kind: "loading" } | { kind: "ready" } | { kind: "error"; detail: string };

export function BootGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  const boot = () => {
    setState({ kind: "loading" });
    initStore().then(
      () => setState({ kind: "ready" }),
      (e: unknown) => setState({ kind: "error", detail: e instanceof Error ? e.message : String(e) }),
    );
  };

  useEffect(boot, []);

  if (state.kind === "ready") return <>{children}</>;

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
          <pre className="overflow-x-auto rounded-sm border border-line bg-bg px-3 py-2 font-mono text-[12px] text-ink-2">cd server &amp;&amp; bun run start</pre>
          <details className="text-[12px] text-ink-3">
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

  // loading
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
