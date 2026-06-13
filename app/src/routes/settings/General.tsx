import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTenant } from "../../lib/tenant-context";
import { apiFetch } from "../../api";
import { Button } from "../../components/Button";
import { FormField } from "../../components/FormField";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ReadOnly } from "../../components/settings/ReadOnly";
import { can } from "../../lib/permissions";
import { useAutosave } from "../../hooks/useAutosave";
import { invalidate } from "../../store";
import { readServerError } from "../../lib/api-errors";
import { cx } from "../../lib/cx";
import { WorkspaceColorPicker } from "../../components/WorkspaceColorPicker";

export function General() {
  const tenant = useTenant();
  const navigate = useNavigate();
  const canEdit = can(tenant, "settings.general.edit");
  const canChangeSlug = tenant.isSuperAdmin && tenant.slug !== "default";
  const [label, setLabel] = useState(tenant.label);
  const [newSlug, setNewSlug] = useState(tenant.slug);
  const [slugBusy, setSlugBusy] = useState(false);
  const [slugError, setSlugError] = useState<string | null>(null);

  const saveSlug = async () => {
    const trimmed = newSlug.trim();
    if (!trimmed || trimmed === tenant.slug) return;
    setSlugBusy(true);
    setSlugError(null);
    try {
      const res = await apiFetch("/slug", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: trimmed }),
      });
      if (!res.ok) {
        const msg = await readServerError(res);
        setSlugError(msg);
        return;
      }
      await invalidate.memberships();
      navigate(`/app/${trimmed}/settings/general`);
    } finally {
      setSlugBusy(false);
    }
  };

  const save = async (next: string) => {
    const trimmed = next.trim();
    if (!trimmed || trimmed === tenant.label) return;
    const res = await apiFetch("", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: trimmed }),
    });
    if (!res.ok) throw new Error(`${res.status}`);
  };
  const autosave = useAutosave(label, save, 600, async () => {
    // Renaming the workspace must refresh: tenant slice (page header,
    // settings header) AND memberships (workspace switcher + dropdown row).
    await invalidate.tenant(tenant.slug);
  });

  return (
    <>
      <SettingsSection
        title="General"
        hint={canChangeSlug ? "Workspace identity." : "Workspace identity. Slug is immutable."}
      >
        <ReadOnly enabled={!canEdit}>
          <FormField
            label="Workspace name"
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
              className="w-full bg-surface border border-line-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={tenant.label}
            />
          </FormField>
        </ReadOnly>

        {!canChangeSlug && (
          <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-3 text-sm mt-6">
            <dt className="font-mono text-[11px] uppercase tracking-widest text-ink-3 pt-0.5">
              Slug
            </dt>
            <dd>
              <code className="font-mono text-accent">{tenant.slug}</code>
              <span className="ml-2 text-xs text-ink-3">immutable</span>
            </dd>
          </dl>
        )}
      </SettingsSection>

      {canEdit && (
        <SettingsSection
          title="Workspace color"
          hint="Used as the avatar background in the workspace switcher."
        >
          <FormField label="Color">
            <WorkspaceColorPicker
              value={tenant.color}
              onChange={async (hex) => {
                await apiFetch("", {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ color: hex }),
                });
                await invalidate.memberships();
              }}
            />
          </FormField>
        </SettingsSection>
      )}

      {canChangeSlug && (
        <SettingsSection
          title="URL slug"
          hint="Renaming the slug changes the URL for everyone using this workspace. Super-admin only."
        >
          <FormField label="Slug">
            <div className="flex items-center gap-2">
              <input
                className="flex-1 bg-surface border border-line-2 px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)}
                placeholder={tenant.slug}
                disabled={slugBusy}
              />
              <Button
                variant="primary"
                size="sm"
                onClick={saveSlug}
                disabled={slugBusy || !newSlug.trim() || newSlug.trim() === tenant.slug}
              >
                {slugBusy ? "Saving…" : "Save"}
              </Button>
            </div>
            {slugError && (
              <p className="mt-1 text-xs text-danger" role="status">
                {slugError}
              </p>
            )}
          </FormField>
        </SettingsSection>
      )}
    </>
  );
}
