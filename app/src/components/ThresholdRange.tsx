/* ThresholdRange — a two-thumb confidence-band picker. The bottom thumb sets
   the 'suggest' threshold (where suggestions appear); the top thumb sets the
   'publish' threshold (where Zug Zug auto-publishes on scan). The visible
   track is built from three positioned divs so its colors mirror the labels.

   Implementation note: two stacked <input type="range"> elements with
   pointer-events disabled on the track and re-enabled on the thumb pseudo-
   elements is the standard library-free dual-range pattern. */

interface Props {
  publish: number;
  suggest: number;
  min?: number;
  max?: number;
  onChange: (next: { publish: number; suggest: number }) => void;
}

export function ThresholdRange({ publish, suggest, min = 50, max = 100, onChange }: Props) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));

  const setPublish = (v: number) => {
    const p = clamp(v);
    onChange({ publish: p, suggest: Math.min(suggest, p) });
  };
  const setSuggest = (v: number) => {
    const s = clamp(v);
    onChange({ publish: Math.max(publish, s), suggest: s });
  };

  const pct = (v: number) => ((v - min) / (max - min)) * 100;

  return (
    <div className="w-full max-w-full md:max-w-md">
      <div className="relative h-10 md:h-6">
        {/* base track */}
        <div className="pointer-events-none absolute inset-y-1/2 left-0 right-0 h-1 -translate-y-1/2 rounded-pill bg-surface-2" />
        {/* suggest..publish band (warn) */}
        <div
          className="pointer-events-none absolute inset-y-1/2 h-1 -translate-y-1/2 rounded-pill bg-warn"
          style={{ left: `${pct(suggest)}%`, right: `${100 - pct(publish)}%` }}
        />
        {/* >= publish band (ok) */}
        <div
          className="pointer-events-none absolute inset-y-1/2 h-1 -translate-y-1/2 rounded-pill bg-ok"
          style={{ left: `${pct(publish)}%`, right: 0 }}
        />
        {/* suggest thumb */}
        <input
          type="range"
          min={min}
          max={max}
          value={suggest}
          onChange={(e) => setSuggest(+e.target.value)}
          aria-label={`Suggest threshold: ${suggest} percent`}
          className="zz-range pointer-events-none absolute inset-0 w-full appearance-none bg-transparent accent-[var(--accent)]"
        />
        {/* publish thumb */}
        <input
          type="range"
          min={min}
          max={max}
          value={publish}
          onChange={(e) => setPublish(+e.target.value)}
          aria-label={`Publish threshold: ${publish} percent`}
          className="zz-range pointer-events-none absolute inset-0 w-full appearance-none bg-transparent accent-[var(--accent)]"
        />
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-1 font-mono text-[11px] text-ink-3">
        <span>
          Below {suggest}%: <span className="text-ink-2">no suggestion</span>
        </span>
        <span>
          {suggest}–{publish}%: <span className="text-warn">suggest</span>
        </span>
        <span>
          ≥ {publish}%: <span className="text-ok">auto-publish</span>
        </span>
      </div>
    </div>
  );
}
