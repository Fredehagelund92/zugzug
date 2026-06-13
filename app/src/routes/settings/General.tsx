import { useState } from "react";
import { useTenant } from "../../lib/tenant-context";
import { apiFetch } from "../../api";
import { FormField } from "../../components/FormField";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ReadOnly } from "../../components/settings/ReadOnly";
import { can } from "../../lib/permissions";
import { useAutosave } from "../../hooks/useAutosave";
import { cx } from "../../lib/cx";

export function General() {
  const tenant = useTenant();
  const canEdit = can(tenant, "settings.general.edit");
  const [label, setLabel] = useState(tenant.label);

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
  const autosave = useAutosave(label, save);

  return (
    <SettingsSection title="General" hint="Workspace identity. Slug is immutable.">
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
