import { useId, type ReactNode } from "react";

export function FormField({
  label,
  hint,
  status,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  status?: ReactNode;
  /** id of the input inside — when set, renders an explicit label binding. */
  htmlFor?: string;
  children: ReactNode;
}) {
  const hintId = useId();
  const body = (
    <>
      <span className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-2">{label}</span>
        {status}
      </span>
      {children}
      {hint && (
        <span id={htmlFor ? hintId : undefined} className="text-[12px] text-ink-2">
          {hint}
        </span>
      )}
    </>
  );
  return htmlFor ? (
    <div className="grid gap-1.5">
      <label htmlFor={htmlFor} className="contents">
        {body}
      </label>
    </div>
  ) : (
    <label className="grid gap-1.5">{body}</label>
  );
}
