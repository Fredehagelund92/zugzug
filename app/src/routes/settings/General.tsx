import { useState } from "react";
import { useTenant } from "../../lib/tenant-context";
import { apiFetch } from "../../api";
import { Button } from "../../components/Button";
import { FormField } from "../../components/FormField";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ReadOnly } from "../../components/settings/ReadOnly";
import { can } from "../../lib/permissions";
import { toast } from "../../components/Toast";

export function General() {
  const tenant = useTenant();
  const canEdit = can(tenant, "settings.general.edit");
  const [label, setLabel] = useState(tenant.label);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!label.trim()) return;
    setSaving(true);
    try {
      // apiFetch("") → /api/t/:slug (bare tenant URL, matches PATCH route in server.ts)
      const res = await apiFetch("", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: label.trim() }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      toast("Workspace renamed — takes effect on next navigation.", "success");
    } catch {
      toast("Failed to rename workspace", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="General" hint="Workspace identity. Slug is immutable.">
      <ReadOnly enabled={!canEdit}>
        <FormField label="Workspace name">
          <div className="flex gap-3">
            <input
              className="flex-1 bg-surface border border-line-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
              placeholder={tenant.label}
            />
            {canEdit && (
              <Button
                onClick={save}
                loading={saving}
                disabled={!label.trim() || label.trim() === tenant.label}
                size="sm"
              >
                Save
              </Button>
            )}
          </div>
        </FormField>
      </ReadOnly>

      <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-3 text-sm mt-6">
        <dt className="font-mono text-[11px] uppercase tracking-widest text-ink-3 pt-0.5">Slug</dt>
        <dd>
          <code className="font-mono text-accent">{tenant.slug}</code>
          <span className="ml-2 text-xs text-ink-3">immutable</span>
        </dd>
      </dl>
    </SettingsSection>
  );
}
