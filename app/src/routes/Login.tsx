import { useState, useEffect } from "react";
import { Mark } from "../components/Mark";

const ERROR_MESSAGES: Record<string, string> = {
  domain: "Only @example.com accounts can access this app.",
  not_allowed: "Your account hasn't been added yet. Ask a team member to add you in Settings.",
  token: "Authentication failed — please try again.",
  state: "Session expired — please try again.",
  no_code: "Login was cancelled.",
};

export function Login() {
  const error = new URLSearchParams(window.location.search).get("error");
  const [devBypass, setDevBypass] = useState(false);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    fetch("/api/auth/dev", { method: "GET", redirect: "manual" })
      .then((r) => {
        // 302 / "opaqueredirect" (Bun returns 302 with status "manual") indicates the route is live.
        // 404 means dev bypass is off.
        const live = r.status === 0 /* opaqueredirect */ || (r.status >= 300 && r.status < 400);
        setDevBypass(live);
      })
      .catch(() => {});
  }, []);

  return (
    <div
      className="grid min-h-screen place-items-center p-8"
      style={{ background: "var(--bg)", color: "var(--ink)" }}
    >
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-8">
        <div className="flex items-center gap-2.5">
          <Mark className="h-7 w-7" />
          <span className="font-display text-lg font-extrabold tracking-tight">
            Zug Zug<span style={{ color: "var(--accent)" }}>.</span>
          </span>
        </div>

        <div>
          <h1 className="font-display text-2xl font-bold">Sign in</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--ink-2)" }}>
            Master data reconciliation · Zugzug.
          </p>
        </div>

        {error && (
          <p className="rounded-sm border px-3 py-2 text-[13px]"
            style={{ borderColor: "var(--warn)", color: "var(--warn)", background: "color-mix(in srgb, var(--warn) 10%, transparent)" }}>
            {ERROR_MESSAGES[error] ?? "Something went wrong — please try again."}
          </p>
        )}

        <a
          href="/api/auth/google"
          className="flex w-full items-center justify-center gap-2.5 rounded-sm border border-[var(--line-2)] bg-[var(--surface-2)] px-4 py-2.5 text-[13px] font-medium transition-colors hover:bg-[var(--hover)]"
        >
          <GoogleIcon />
          Sign in with Google
        </a>

        {devBypass && (
          <a
            href="/api/auth/dev"
            className="flex w-full items-center justify-center rounded-sm border border-dashed border-[var(--line-2)] px-4 py-2 text-[12px] text-[var(--ink-3)] transition-colors hover:border-[var(--accent)] hover:text-[var(--ink)]"
          >
            Dev mode login
          </a>
        )}
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M16.51 8H8.98v3h4.3c-.18 1-.74 1.48-1.6 2.04v2.01h2.6a7.8 7.8 0 0 0 2.38-5.88c0-.57-.05-.66-.15-1.18z" />
      <path fill="#34A853" d="M8.98 17c2.16 0 3.97-.72 5.3-1.94l-2.6-2.01c-.72.48-1.63.77-2.7.77-2.08 0-3.84-1.4-4.47-3.29H1.83v2.07A8 8 0 0 0 8.98 17z" />
      <path fill="#FBBC05" d="M4.51 10.53A4.8 4.8 0 0 1 4.26 9c0-.53.09-1.04.25-1.53V5.4H1.83A8 8 0 0 0 .98 9c0 1.29.31 2.51.85 3.6l2.68-2.07z" />
      <path fill="#EA4335" d="M8.98 3.58c1.17 0 2.23.4 3.06 1.2l2.3-2.3A8 8 0 0 0 1.83 5.4L4.51 7.47c.63-1.89 2.39-3.89 4.47-3.89z" />
    </svg>
  );
}
