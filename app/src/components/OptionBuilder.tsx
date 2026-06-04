import { useState } from "react";
import { Chip } from "./datagrid/Chip";
import { PALETTE, PALETTE_NAMES } from "../lib/palette";
import type { OptionDef } from "../data";
import type { PaletteName } from "../lib/palette";

interface OptionBuilderProps {
  options: OptionDef[];
  onChange: (next: OptionDef[]) => void;
  /** Optional default color for newly created options. */
  defaultColor?: PaletteName | null;
}

/** Inline option editor: render existing options as colored chips (click to
 *  remove), plus a label-input + 7-swatch row to append a new option.
 *
 *  Used by CreateTableModal's field scaffold and by the in-grid AddColumn
 *  widget when the user picks type=select. The two callers share this shape
 *  so option ergonomics stay identical across creation and post-creation. */
export function OptionBuilder({ options, onChange, defaultColor = null }: OptionBuilderProps) {
  const [label, setLabel] = useState("");
  const [color, setColor] = useState<PaletteName | null>(defaultColor);

  const remove = (target: string): void => onChange(options.filter((o) => o.label !== target));
  const add = (): void => {
    const t = label.trim();
    if (!t || options.some((o) => o.label === t)) return;
    onChange([...options, { label: t, color }]);
    setLabel("");
    // color stays — usually you want a sequence (high/medium/low) with related tints
  };

  return (
    <div className="space-y-2 rounded-sm border border-line bg-bg/40 p-2">
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            onClick={() => remove(o.label)}
            title="click to remove"
            className="transition-opacity hover:opacity-70"
          >
            <Chip label={o.label} color={o.color} />
          </button>
        ))}
        {options.length === 0 && (
          <span className="font-mono text-[10.5px] text-ink-3">no options yet · add some below</span>
        )}
      </div>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        placeholder="option label…"
        className="w-full rounded-sm border border-line-2 bg-bg px-2 py-1 font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
      />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {PALETTE_NAMES.map((c) => (
            <button
              key={c} type="button"
              onClick={() => setColor(c)}
              title={c}
              className={`h-3.5 w-3.5 shrink-0 rounded-sm ${color === c ? "ring-1 ring-ink" : ""}`}
              style={{ background: PALETTE[c].bg }}
            />
          ))}
          <button
            type="button"
            onClick={() => setColor(null)}
            title="no color"
            className={`h-3.5 w-3.5 shrink-0 rounded-sm border border-line-2 ${color === null ? "ring-1 ring-ink" : ""}`}
          />
        </div>
        <button
          type="button"
          onClick={add}
          disabled={!label.trim()}
          className="shrink-0 rounded-sm border border-line-2 px-2 py-1 font-mono text-[11px] text-accent transition-colors hover:border-accent disabled:opacity-40"
        >
          add
        </button>
      </div>
    </div>
  );
}
