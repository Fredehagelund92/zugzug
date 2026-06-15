import { useEffect, useRef, type ReactNode } from "react";
import { useTenant } from "../../lib/tenant-context";

interface Props {
  id: string;
  summary: string;
  children: ReactNode;
}

export function DeveloperDetails({ id, summary, children }: Props) {
  const tenant = useTenant();
  const isAdmin = tenant.role === "admin" || tenant.isSuperAdmin;
  const ref = useRef<HTMLDetailsElement>(null);
  const storageKey = `zz:dev-details:${id}`;

  useEffect(() => {
    if (!isAdmin || !ref.current) return;
    if (localStorage.getItem(storageKey) === "1") ref.current.open = true;
  }, [isAdmin, storageKey]);

  if (!isAdmin) return null;
  return (
    <details
      ref={ref}
      data-testid="developer-details"
      className="rounded-sm border border-line bg-surface-2 p-3 text-[12px]"
      onToggle={(e) => {
        localStorage.setItem(storageKey, (e.currentTarget as HTMLDetailsElement).open ? "1" : "0");
      }}
    >
      <summary className="cursor-pointer text-ink-2 font-mono uppercase tracking-wider text-[10px]">
        {summary}
      </summary>
      <div className="pt-2 text-ink-2">{children}</div>
    </details>
  );
}
