import { useState, useEffect, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { authFetch } from "../api";
import { Mark } from "../components/Mark";
import { useAuthConfig } from "../store";

const ERROR_MESSAGES: Record<string, string> = {
  domain: "Your email domain is not allowed on this instance. Contact your admin.",
  not_allowed: "Your account hasn't been added yet. Ask an existing user to add you in Settings.",
  token: "Authentication failed — please try again.",
  state: "Session expired — please try again.",
  no_code: "Login was cancelled.",
  no_email: "Your provider didn't return an email — please check your account settings.",
  invalid_credentials: "Invalid email or password.",
};

export function Login() {
  const error = new URLSearchParams(window.location.search).get("error");
  const authConfig = useAuthConfig();
  const [devBypass, setDevBypass] = useState(false);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    authFetch("/auth/dev", { method: "GET", redirect: "manual" })
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
      className="grid min-h-screen place-items-center p-4 sm:p-8"
      style={{ background: "var(--bg)", color: "var(--ink)" }}
    >
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-5 sm:p-8">
        <div className="flex items-center gap-2.5">
          <Mark className="h-7 w-7" />
          <span className="font-display text-lg font-extrabold tracking-tight">
            Zug Zug<span style={{ color: "var(--accent)" }}>.</span>
          </span>
        </div>

        <div>
          <h1 className="font-display text-2xl font-bold">Sign in</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--ink-2)" }}>
            Master data reconciliation.
          </p>
        </div>

        {error && (
          <p
            className="rounded-sm border px-3 py-2 text-[13px]"
            style={{
              borderColor: "var(--warn)",
              color: "var(--warn)",
              background: "color-mix(in srgb, var(--warn) 10%, transparent)",
            }}
          >
            {ERROR_MESSAGES[error] ?? "Something went wrong — please try again."}
          </p>
        )}

        {authConfig?.mode === "password" && (
          <PasswordForm allowedDomain={authConfig.allowedDomain} />
        )}
        {authConfig?.mode === "oidc" && (
          <OidcSection
            label={authConfig.oidcLabel ?? "SSO"}
            allowedDomain={authConfig.allowedDomain}
          />
        )}

        {devBypass && (
          <a
            href="/api/auth/dev"
            className="flex w-full items-center justify-center rounded-sm border border-dashed border-[var(--line-2)] px-4 py-2 text-[12px] text-[var(--ink-3)] transition-colors hover:border-[var(--accent)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Dev mode login
          </a>
        )}
      </div>
    </div>
  );
}

function PasswordForm({ allowedDomain }: { allowedDomain: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await authFetch("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.status === 200) {
        window.location.href = "/app";
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setFormError(ERROR_MESSAGES[body?.error ?? "invalid_credentials"] ?? "Login failed.");
    } catch {
      setFormError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="space-y-3" onSubmit={onSubmit}>
      <label className="block text-[12px]" style={{ color: "var(--ink-2)" }}>
        Email
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 block w-full rounded-sm border border-[var(--line-2)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        />
      </label>
      <label className="block text-[12px]" style={{ color: "var(--ink-2)" }}>
        Password
        <input
          type="password"
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 block w-full rounded-sm border border-[var(--line-2)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        />
      </label>
      {formError && (
        <p className="text-[12px]" style={{ color: "var(--warn)" }}>
          {formError}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="flex w-full items-center justify-center rounded-sm border border-[var(--line-2)] bg-[var(--accent)] px-4 py-2.5 text-[13px] font-medium text-[var(--bg)] transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {submitting ? "Signing in…" : "Sign in"}
      </button>
      <p className="text-center text-[12px]" style={{ color: "var(--ink-3)" }}>
        <Link to="/signup" className="text-[var(--accent)] hover:underline">
          No account? Sign up →
        </Link>
      </p>
      {allowedDomain && (
        <p className="text-center text-[11px]" style={{ color: "var(--ink-3)" }}>
          Only @{allowedDomain} accounts can sign up here.
        </p>
      )}
    </form>
  );
}

function OidcSection({ label, allowedDomain }: { label: string; allowedDomain: string | null }) {
  return (
    <div className="space-y-3">
      <a
        href="/api/auth/oidc/start"
        className="flex w-full items-center justify-center gap-2.5 rounded-sm border border-[var(--line-2)] bg-[var(--surface-2)] px-4 py-2.5 text-[13px] font-medium transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        Sign in with {label}
      </a>
      {allowedDomain && (
        <p className="text-center text-[11px]" style={{ color: "var(--ink-3)" }}>
          Only @{allowedDomain} accounts can sign in here.
        </p>
      )}
    </div>
  );
}
