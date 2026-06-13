import { ThresholdRange } from "../../components/ThresholdRange";
import { usePreferences, setPreferences, invalidate } from "../../store";
import { useTenant } from "../../lib/tenant-context";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ReadOnly } from "../../components/settings/ReadOnly";
import { can } from "../../lib/permissions";
import { FormField } from "../../components/FormField";

export function Matching() {
  const tenant = useTenant();
  const canEdit = can(tenant, "settings.matching.edit");
  const prefs = usePreferences();

  return (
    <SettingsSection
      title="Matching defaults"
      hint="How aggressively Zug Zug matches new values when a scan finds them."
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
    </SettingsSection>
  );
}
