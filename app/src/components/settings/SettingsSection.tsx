import { Card } from "../Card";

export function SettingsSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-0">
      <div className="border-b border-line px-4 py-3 md:px-6 md:py-4">
        <div className="max-w-2xl">
          <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
          {hint && <p className="mt-0.5 text-[13px] text-ink-2">{hint}</p>}
        </div>
      </div>
      <div className="px-4 py-4 md:px-6 md:py-5">
        <div className="max-w-2xl space-y-5">{children}</div>
      </div>
    </Card>
  );
}
