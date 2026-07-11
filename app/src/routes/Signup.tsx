import { useState, type FormEvent } from "react";
import { usePageTitle } from "../hooks/usePageTitle";
import { Link } from "react-router-dom";
import { authFetch } from "../api";
import { Mark } from "../components/Mark";

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
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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
          <h1 className="font-display text-2xl font-bold">Sign up</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--ink-2)" }}>
            Create your account.
          </p>
        </div>

        <form className="space-y-3" onSubmit={onSubmit}>
          <label className="block text-[12px]" style={{ color: "var(--ink-2)" }}>
            Name
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 block w-full rounded-sm border border-[var(--line-2)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </label>
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
            Password (at least 12 characters)
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
            {submitting ? "Creating account…" : "Sign up"}
          </button>
          <p className="text-center text-[12px]" style={{ color: "var(--ink-3)" }}>
            <Link to="/login" className="text-[var(--accent)] hover:underline">
              Have an account? Sign in →
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
