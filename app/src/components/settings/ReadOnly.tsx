import type { ReactNode } from "react";
import { Children, cloneElement, isValidElement } from "react";

export function ReadOnly({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const processedChildren = enabled
    ? Children.map(children, (child) => {
        if (isValidElement(child)) {
          return cloneElement(child as any, { disabled: true });
        }
        return child;
      })
    : children;

  return (
    <fieldset
      disabled={enabled}
      aria-disabled={enabled || undefined}
      className={enabled ? "opacity-70 cursor-not-allowed" : undefined}
    >
      {processedChildren}
    </fieldset>
  );
}
