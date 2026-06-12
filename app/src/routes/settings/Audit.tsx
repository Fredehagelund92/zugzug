import { useAudit } from "../../store";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { relativeTime } from "./_shared";

export function Audit() {
  const audit = useAudit();

  return (
    <SettingsSection
      title="Audit log"
      hint="Workspace activity. Newest first. Read-only for every role."
    >
      {audit.length === 0 ? (
        <p className="text-sm text-ink-3">No activity yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {audit.slice(0, 100).map((row, i) => (
            <li key={i} className="py-2.5 grid grid-cols-[160px_160px_1fr] gap-3 items-baseline text-sm">
              <span className="font-mono text-xs text-ink-3 tabular-nums">
                {relativeTime(row.at ?? null)}
              </span>
              <code className="font-mono text-xs text-accent truncate">{row.action}</code>
              <span className="text-ink-2 truncate">{row.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
