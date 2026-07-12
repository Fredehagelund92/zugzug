import { Children, cloneElement, isValidElement, useId, type ReactNode } from "react";

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
  const child =
    htmlFor && hint && Children.count(children) === 1 && isValidElement(children)
      ? cloneElement(children as React.ReactElement<{ "aria-describedby"?: string }>, {
          "aria-describedby": hintId,
        })
      : children;
  const body = (
    <>
      <span className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-2">{label}</span>
        {status}
      </span>
      {child}
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
