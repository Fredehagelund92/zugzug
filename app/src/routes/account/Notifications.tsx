import { SettingsSection } from "../../components/settings/SettingsSection";

export function Notifications() {
  return (
    <SettingsSection
      title="Notifications"
      hint="Email and in-app notification preferences."
    >
      <p className="text-sm text-ink-3">
        Notification settings are coming in a future release.
      </p>
    </SettingsSection>
  );
}
