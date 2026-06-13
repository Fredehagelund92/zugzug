import { useAudit } from "../store";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { relativeTime } from "./settings/_shared";

export function Audit() {
  const audit = useAudit();
  return (
    <div className="mx-auto w-full max-w-[var(--wide)] p-4 md:p-8">
      <PageHeader
        kicker="Workspace"
        title="Audit"
        lede="Activity across this workspace. Newest first."
        count={audit.length === 0 ? undefined : audit.length}
      />

      <div className="mt-8">
        {audit.length === 0 ? (
          <EmptyState
            title="No activity yet"
            body="Drafts, commits, member changes, and other workspace actions will appear here."
          />
        ) : (
          <ul className="divide-y divide-line">
            {audit.slice(0, 100).map((row, i) => (
              <li
                key={i}
                className="py-2.5 grid grid-cols-[160px_160px_1fr] gap-3 items-baseline text-sm"
              >
                <span className="font-mono text-xs text-ink-3 tabular-nums">
                  {relativeTime(row.at ?? null)}
                </span>
                <code className="font-mono text-xs text-accent truncate">{row.action}</code>
                <span className="text-ink-2 truncate">{row.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
