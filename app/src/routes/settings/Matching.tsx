import { ThresholdRange } from "../../components/ThresholdRange";
import { usePreferences, setPreferences, invalidate } from "../../store";
import { useTenant } from "../../lib/tenant-context";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { SettingsPageHeader } from "../../components/settings/SettingsPageHeader";
import { ReadOnly } from "../../components/settings/ReadOnly";
import { can } from "../../lib/permissions";
import { FormField } from "../../components/FormField";
import { Checkbox } from "../../components/Checkbox";

export function Matching() {
  const tenant = useTenant();
  const canEdit = can(tenant, "settings.matching.edit");
  const canEditGov = can(tenant, "settings.general.edit");
  const prefs = usePreferences();

  return (
    <div className="space-y-8">
      <SettingsPageHeader title="Mapping" />
      <SettingsSection
        title="Mapping defaults"
        hint="How aggressively Zug Zug maps new source values when a scan finds them."
      >
        <ReadOnly enabled={!canEdit}>
          <FormField label="Confidence bands">
            <ThresholdRange
              publish={prefs.publishThreshold}
              suggest={prefs.suggestThreshold}
              onChange={({ publish, suggest }) => {
                void setPreferences({
                  ...prefs,
                  publishThreshold: publish,
                  suggestThreshold: suggest,
                }).then(() => invalidate.tenant(tenant.slug));
              }}
            />
          </FormField>
        </ReadOnly>
        <FormField
          label="Publish exact matches on its own"
          hint="When on, Zug Zug publishes the mappings it made itself on an exact name match — the source value “Germany” to the record Germany. It never publishes a draft one of your teammates wrote."
        >
          <Checkbox
            state={prefs.autoPublishEnabled ? "on" : "off"}
            disabled={!canEditGov}
            onClick={() =>
              void setPreferences({
                ...prefs,
                autoPublishEnabled: !prefs.autoPublishEnabled,
              }).then(() => invalidate.tenant(tenant.slug))
            }
            aria-label="Publish exact matches on its own"
          />
        </FormField>
        <FormField
          label="Four eyes on publish"
          hint="When on, a draft's author can't publish it — a second editor must. Applies to mapping drafts only; record edits are not drafted."
        >
          <Checkbox
            state={prefs.requireSecondPublisher ? "on" : "off"}
            disabled={!canEditGov}
            onClick={() =>
              void setPreferences({
                ...prefs,
                requireSecondPublisher: !prefs.requireSecondPublisher,
              }).then(() => invalidate.tenant(tenant.slug))
            }
            aria-label="Require a second publisher"
          />
        </FormField>
      </SettingsSection>
    </div>
  );
}
