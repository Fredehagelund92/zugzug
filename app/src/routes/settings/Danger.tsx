import { SettingsSection } from "../../components/settings/SettingsSection";

export function Danger() {
  return (
    <SettingsSection
      title="Danger zone"
      hint="Workspace destruction lives here. Leave & delete actions ship in the next release."
    >
      <p className="text-sm text-ink-3">No actions available yet.</p>
    </SettingsSection>
  );
}
