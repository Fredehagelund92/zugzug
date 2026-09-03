import { useEffect, useState, type FormEvent } from "react";
import { authFetch } from "../../api";
import { Button } from "../../components/Button";
import { FormField } from "../../components/FormField";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { useAuthConfig, useCurrentUser, invalidate } from "../../store";
import { useAutosave } from "../../hooks/useAutosave";
import { cx } from "../../lib/cx";

export function Profile() {
  const user = useCurrentUser();
  const authConfig = useAuthConfig();
  const [name, setName] = useState(user?.name ?? "");

  // Sync local field when the user arrives or changes upstream (e.g. after a
  // refetch from invalidate.currentUser()). useState's initializer only runs
  // on mount; without this the field stays empty while the user is loading.
  useEffect(() => {
    if (user?.name && user.name !== name) setName(user.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.name]);

  const save = async (next: string) => {
    const trimmed = next.trim();
    if (!trimmed || trimmed === user?.name) return;
    const res = await authFetch("/auth/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    if (!res.ok) throw new Error(`${res.status}`);
  };
  const autosave = useAutosave(name, save, 600, () => invalidate.currentUser());

  const signOut = () =>
    authFetch("/auth/logout", { method: "POST" }).then(() => window.location.replace("/login"));

  return (
    <>
      <SettingsSection title="Profile" hint="Your display name and email address.">
        <FormField
          label="Display name"
          status={
            <span
              className={cx(
                "font-mono text-[10.5px]",
                autosave.status === "error" ? "text-danger" : "text-ink-3",
              )}
              aria-live="polite"
            >
              {autosave.status === "saving" && "saving…"}
              {autosave.status === "saved" && "saved"}
              {autosave.status === "error" && (autosave.error ?? "couldn't save")}
            </span>
          }
        >
          <input
            className="rounded-sm w-full bg-surface border border-line-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
          />
        </FormField>
        <FormField label="Email">
          <p className="text-sm text-ink-2">{user?.email ?? "—"}</p>
          <p className="mt-1 text-xs text-ink-3">Email changes coming soon.</p>
        </FormField>
      </SettingsSection>

      {authConfig?.mode === "password" && <PasswordSection />}

      <SettingsSection title="Session">
        <div className="flex items-center justify-between">
          <p className="text-sm text-ink-2">
            Signed in as <span className="text-ink">{user?.email}</span>
          </p>
          <Button variant="ghost" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </SettingsSection>
    </>
  );
}

const PASSWORD_ERRORS: Record<string, string> = {
  wrong_current_password: "That isn't your current password.",
  password_too_short: "Your new password must be at least 12 characters.",
  not_password_user: "This account signs in through your identity provider.",
};

/** Change your own password. Only shown on password deployments — an OIDC
 *  account has none to change. */
function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const res = await authFetch("/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      if (res.ok) {
        setCurrent("");
        setNext("");
        setDone(true);
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(PASSWORD_ERRORS[body?.error ?? ""] ?? "Couldn't change your password.");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "rounded-sm w-full bg-surface border border-line-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors";

  return (
    <SettingsSection title="Password" hint="Change the password you sign in with.">
      <form className="space-y-6" onSubmit={(e) => void submit(e)}>
        <FormField label="Current password">
          <input
            type="password"
            autoComplete="current-password"
            className={inputClass}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </FormField>
        <FormField label="New password" hint="At least 12 characters." htmlFor="new-password">
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            className={inputClass}
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </FormField>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" size="sm" disabled={busy || !current || !next}>
            {busy ? "Changing…" : "Change password"}
          </Button>
          {done && (
            <span className="font-mono text-[10.5px] text-ink-3" role="status">
              password changed
            </span>
          )}
        </div>
        {error && (
          <p className="text-xs text-danger" role="status">
            {error}
          </p>
        )}
      </form>
    </SettingsSection>
  );
}
