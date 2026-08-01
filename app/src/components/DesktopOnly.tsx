import { useState, type ReactNode } from "react";
import { useIsMobile } from "../lib/use-media-query";

interface Props {
  /** Plain-words explanation shown when tapped on a phone. */
  reason: string;
  children: ReactNode;
}

/**
 * Keeps a desktop-only control visible on a phone but inert: tapping it
 * explains why instead of opening something unusable. Visible-and-explained
 * beats hidden, which reads as a missing feature.
 */
export function DesktopOnly({ reason, children }: Props) {
  const isMobile = useIsMobile();
  const [showReason, setShowReason] = useState(false);

  if (!isMobile) return <>{children}</>;

  return (
    <div className="relative inline-flex flex-col">
      <div
        onClickCapture={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setShowReason(true);
        }}
        className="opacity-60"
      >
        {children}
      </div>
      {showReason && (
        <p role="status" className="mt-1.5 max-w-[16rem] text-[12px] leading-snug text-ink-2">
          {reason}
        </p>
      )}
    </div>
  );
}
