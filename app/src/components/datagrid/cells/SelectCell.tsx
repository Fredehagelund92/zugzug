import { useEffect, useMemo, useRef, useState } from "react";
import { Chip } from "../Chip";
import { PALETTE, PALETTE_NAMES } from "../../../lib/palette";
import type { CellCtx, EditCtx } from "../types";
import type { OptionDef } from "../../../data";
import type { PaletteName } from "../../../lib/palette";

/* SelectCell — single-select chip cell. Renderer reads the option's color from
   column.options; editor shows existing options as colored dots + labels, and
   the inline "+ option" affordance includes a 7-swatch color picker. */

function Renderer<Row>({ value, column }: CellCtx<Row>) {
  if (value == null || value === "") {
    return <span className="font-mono text-[12px] text-ink-2">—</span>;
  }
  const label = String(value);
  const opt = column.options?.find((o) => o.label === label);
  return <Chip label={label} color={opt?.color ?? null} />;
}

interface SelectEditorProps<Row> extends EditCtx<Row> {
  options: OptionDef[];
  /** Host hook — creates an option with optional color. Returns the new list. */
  onCreate: (label: string, color: PaletteName | null) => Promise<OptionDef[]>;
}

function Editor<Row>(props: SelectEditorProps<Row>) {
  const { value, commit, cancel, options, onCreate } = props;
  const [opts, setOpts] = useState(options);
  const [q, setQ] = useState("");
  const [hl, setHl] = useState(0);
  const [pickedColor, setPickedColor] = useState<PaletteName | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return opts;
    return opts.filter((o) => o.label.toLowerCase().includes(needle));
  }, [opts, q]);
  const exact = filtered.some((o) => o.label.toLowerCase() === q.trim().toLowerCase());
  const canCreate = q.trim().length > 0 && !exact;

  const choose = (label: string) => commit(label);
  const create = async () => {
    const label = q.trim();
    if (!label) return;
    const next = await onCreate(label, pickedColor);
    setOpts(next);
    commit(label);
  };

  return (
    <div className="absolute left-0 top-0 z-30 w-[240px] rounded-sm border border-line-2 bg-surface p-1 shadow-lg" onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef} value={q}
        placeholder="search or create…"
        onChange={(e) => { setQ(e.target.value); setHl(0); }}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
          if (e.key === "ArrowDown") { e.preventDefault(); setHl((h) => Math.min(filtered.length, h + 1)); return; }
          if (e.key === "ArrowUp")   { e.preventDefault(); setHl((h) => Math.max(0, h - 1)); return; }
          if (e.key === "Enter") {
            e.preventDefault();
            if (hl < filtered.length) choose(filtered[hl].label);
            else if (canCreate) void create();
            return;
          }
        }}
        className="mb-1 w-full rounded-sm border border-line-2 bg-bg px-2 py-1 font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
      />
      <div className="max-h-48 overflow-y-auto">
        {filtered.map((o, i) => (
          <button
            key={o.label} type="button"
            onMouseEnter={() => setHl(i)}
            onMouseDown={(e) => { e.preventDefault(); choose(o.label); }}
            className={`flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left ${i === hl ? "bg-accent-wash" : "hover:bg-hover"}`}
          >
            {o.color && <span className="h-2 w-2 rounded-pill" style={{ background: PALETTE[o.color].bg }} />}
            <span className="font-mono text-[11.5px] text-ink">{o.label}</span>
          </button>
        ))}
        {value != null && value !== "" && !filtered.some((o) => o.label === String(value)) && (
          <div className="px-2 py-1 font-mono text-[10.5px] text-ink-3">current: {String(value)}</div>
        )}
        {canCreate && (
          <div className="mt-1 border-t border-line pt-1">
            <div className="flex items-center gap-1 px-2 py-1">
              {PALETTE_NAMES.map((c) => (
                <button
                  key={c} type="button"
                  onMouseDown={(e) => { e.preventDefault(); setPickedColor(c); }}
                  title={c}
                  className={`h-3.5 w-3.5 rounded-sm ${pickedColor === c ? "ring-1 ring-ink" : ""}`}
                  style={{ background: PALETTE[c].bg }}
                />
              ))}
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); setPickedColor(null); }}
                title="no color"
                className={`h-3.5 w-3.5 rounded-sm border border-line-2 ${pickedColor === null ? "ring-1 ring-ink" : ""}`}
              />
            </div>
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); void create(); }}
              className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left font-mono text-[11px] text-accent hover:bg-accent-wash"
            >
              + create option "{q.trim()}"{pickedColor ? ` · ${pickedColor}` : ""}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export const SelectCell = { Renderer, Editor };
