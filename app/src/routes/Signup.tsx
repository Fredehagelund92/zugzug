import { useState, useId, type FormEvent } from "react";
import { usePageTitle } from "../hooks/usePageTitle";
import { Link } from "react-router-dom";
import { authFetch } from "../api";
import { useAuthConfig } from "../store";
import { AuthLayout } from "../components/auth/AuthLayout";
import { Button } from "../components/Button";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_email: "That doesn't look like an email address.",
  password_too_short: "Password must be at least 12 characters.",
  name_required: "Please enter your name.",
  domain_not_allowed: "Your email domain isn't allowed on this instance.",
  not_allowed:
    "Your email has not been added to the allowlist yet. Ask an existing user to invite you in Settings → Team.",
  email_taken: "An account with this email already exists. Try signing in instead.",
};

export function Signup() {
  usePageTitle("Sign up");
  const authConfig = useAuthConfig();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const passwordHintId = useId();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await authFetch("/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      if (res.status === 200) {
        window.location.href = "/app";
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        minLength?: number;
      } | null;
      const msg = ERROR_MESSAGES[body?.error ?? ""] ?? "Sign up failed — please try again.";
      setFormError(msg);
    } catch {
      setFormError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout>
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Sign up</h1>
          <p className="mt-1 text-sm text-ink-2">Create your account.</p>
        </div>

        <form className="space-y-4" onSubmit={onSubmit}>
          <label className="block text-xs font-semibold text-ink-2">
            Name
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1.5 block w-full rounded-sm border border-line-2 bg-surface-2 px-3 py-[11px] text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </label>
          <label className="block text-xs font-semibold text-ink-2">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1.5 block w-full rounded-sm border border-line-2 bg-surface-2 px-3 py-[11px] text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </label>
          <label className="block text-xs font-semibold text-ink-2">
            Password
            <input
              id="signup-password"
              type="password"
              required
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby={passwordHintId}
              className="mt-1.5 block w-full rounded-sm border border-line-2 bg-surface-2 px-3 py-[11px] text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </label>
          <span id={passwordHintId} className="mt-1 block text-[11px] font-normal text-ink-3">
            At least 12 characters.
          </span>
          {formError && <p className="text-xs text-warn">{formError}</p>}
          <Button type="submit" variant="primary" size="lg" loading={submitting} className="w-full">
            {submitting ? "Creating account…" : "Sign up"}
          </Button>
          <p className="text-center text-xs text-ink-3">
            <Link to="/login" className="font-semibold text-accent hover:underline">
              Have an account? Sign in →
            </Link>
          </p>
          {authConfig?.allowedDomain && (
            <p className="text-center text-[11px] text-ink-3">
              Only @{authConfig.allowedDomain} accounts can sign up here.
            </p>
          )}
        </form>
      </div>
    </AuthLayout>
  );
}
