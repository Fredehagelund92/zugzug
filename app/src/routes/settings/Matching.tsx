import { usePreferences, setPreferences, invalidate } from "../../store";
import { useTenant } from "../../lib/tenant-context";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { SettingsPageHeader } from "../../components/settings/SettingsPageHeader";
import { can } from "../../lib/permissions";
import { FormField } from "../../components/FormField";
import { Checkbox } from "../../components/Checkbox";
import { toast } from "../../components/Toast";

export function Matching() {
  const tenant = useTenant();
  const canEditGov = can(tenant, "settings.general.edit");
  const prefs = usePreferences();

  /** Writes go through PUT /api/preferences, which can refuse (403) or fail —
   *  say so instead of leaving the control looking as if it took. */
  const save = (next: Parameters<typeof setPreferences>[0]) => {
    setPreferences(next)
      .then(() => invalidate.tenant(tenant.slug))
      .catch((e: unknown) => {
        toast(
          e instanceof Error ? `Couldn't save: ${e.message}` : "Couldn't save that setting.",
          "error",
        );
      });
  };

  return (
    <div className="space-y-8">
      <SettingsPageHeader title="Mapping" />
      <SettingsSection
        title="Mapping defaults"
        hint="What Zug Zug is allowed to do on its own when a scan finds new source values."
      >
        <FormField
          label="Publish exact matches on its own"
          hint="When on, Zug Zug publishes the mappings it made itself on an exact name match — the source value “Germany” to the record Germany. It never publishes a draft one of your teammates wrote."
        >
          <Checkbox
            state={prefs.autoPublishEnabled ? "on" : "off"}
            disabled={!canEditGov}
            onClick={() => save({ ...prefs, autoPublishEnabled: !prefs.autoPublishEnabled })}
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
              save({ ...prefs, requireSecondPublisher: !prefs.requireSecondPublisher })
            }
            aria-label="Require a second publisher"
          />
        </FormField>
      </SettingsSection>
    </div>
  );
}
