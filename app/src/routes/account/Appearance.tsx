import { FormField } from "../../components/FormField";
import { useEngineerMode } from "../../lib/engineer-mode";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { cx } from "../../lib/cx";

export function Appearance() {
  const { engineer, setEngineer } = useEngineerMode();

  return (
    <SettingsSection title="Appearance" hint="Theme follows the toggle in the top bar.">
      <FormField label="Engineer details">
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={engineer}
            aria-label="Engineer details"
            onClick={() => setEngineer(!engineer)}
            className={cx("ak-toggle", engineer && "on")}
          />
          <span className="text-[13px] text-ink-2">
            Show warehouse table names, SQL, and join warnings
          </span>
        </div>
      </FormField>
    </SettingsSection>
  );
}
