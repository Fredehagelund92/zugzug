import { useEffect, useState } from "react";
import { authFetch } from "../../api";
import { Button } from "../../components/Button";
import { FormField } from "../../components/FormField";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { useCurrentUser, invalidate } from "../../store";
import { useAutosave } from "../../hooks/useAutosave";
import { cx } from "../../lib/cx";

export function Profile() {
  const user = useCurrentUser();
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
