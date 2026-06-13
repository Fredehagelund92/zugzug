import { useTenant } from "../../lib/tenant-context";
import { SettingsSection } from "../../components/settings/SettingsSection";

export function General() {
  const tenant = useTenant();

  return (
    <SettingsSection title="General" hint="Workspace identity. Slug is immutable.">
      <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-3 text-sm">
        <dt className="font-mono text-[11px] uppercase tracking-widest text-ink-3 pt-0.5">Label</dt>
        <dd className="text-ink">{tenant.label}</dd>

        <dt className="font-mono text-[11px] uppercase tracking-widest text-ink-3 pt-0.5">Slug</dt>
        <dd>
          <code className="font-mono text-accent">{tenant.slug}</code>
        </dd>
      </dl>
      <p className="mt-4 text-xs text-ink-3">
        Renaming the workspace label is coming in a follow-up release.
      </p>
    </SettingsSection>
  );
}
