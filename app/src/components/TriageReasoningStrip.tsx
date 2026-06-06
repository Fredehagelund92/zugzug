// app/src/components/TriageReasoningStrip.tsx
import type { AiHint } from "../lib/use-ai-hint";

interface Props {
  loading: boolean;
  hint:    AiHint | null;
}

export function TriageReasoningStrip({ loading, hint }: Props) {
  // Error state or no data yet — render nothing (confidence bar is the fallback).
  if (!loading && !hint) return null;

  if (loading) {
    return (
      <div className="mb-2 flex items-center gap-1.5 pl-[2px]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-pill bg-accent/30" aria-hidden="true" />
        {/* ak-skeleton applies the shimmer gradient + animation from app-kit.css */}
        <div className="ak-skeleton h-[10px] w-[58%] rounded-sm" />
      </div>
    );
  }

  if (!hint?.reasoning) return null;

  return (
    <div
      className="mb-2 flex items-start gap-1.5 pl-[2px]"
      style={{ animation: "zz-rise var(--dur-slide) both" }}
    >
      <span
        className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-pill bg-accent/50"
        aria-hidden="true"
      />
      <p className="font-mono text-[11px] italic leading-snug text-ink-2">
        {hint.reasoning}
      </p>
    </div>
  );
}
