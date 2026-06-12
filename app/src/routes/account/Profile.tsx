import { useState, useEffect } from "react";
import { authFetch } from "../../api";
import { Button } from "../../components/Button";
import { FormField } from "../../components/FormField";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { toast } from "../../components/Toast";
import { useCurrentUser } from "../../store";

export function Profile() {
  const user = useCurrentUser();
  const [name, setName] = useState(user?.name ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user?.name) setName(user.name);
  }, [user?.name]);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await authFetch("/auth/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      toast("Name updated", "success");
    } catch {
      toast("Failed to update name", "error");
    } finally {
      setSaving(false);
    }
  };

  const signOut = () =>
    authFetch("/auth/logout", { method: "POST" }).then(() =>
      window.location.replace("/login"),
    );

  return (
    <>
      <SettingsSection title="Profile" hint="Your display name and email address.">
        <FormField label="Display name">
          <div className="flex gap-3">
            <input
              className="flex-1 bg-surface border border-line-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
              placeholder="Your name"
            />
            <Button
              onClick={save}
              loading={saving}
              disabled={!name.trim() || name.trim() === user?.name}
              size="sm"
            >
              Save
            </Button>
          </div>
        </FormField>
        <FormField label="Email">
          <p className="text-sm text-ink-2">{user?.email ?? "—"}</p>
          <p className="mt-1 text-xs text-ink-3">Email cannot be changed here.</p>
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
