import { WORKSPACE_COLORS, workspaceColor } from "../lib/workspace-colors";

interface Props {
  value: string | null;
  onChange: (hex: string) => void;
  disabled?: boolean;
}

export function WorkspaceColorPicker({ value, onChange, disabled }: Props) {
  const selected = workspaceColor(value);
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {WORKSPACE_COLORS.map((hex) => (
        <button
          key={hex}
          type="button"
          onClick={() => !disabled && onChange(hex)}
          disabled={disabled}
          aria-label={hex}
          aria-pressed={hex === selected}
          className="w-[22px] h-[22px] rounded-[5px] transition-transform hover:scale-110 focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: hex,
            boxShadow: hex === selected ? `0 0 0 2px var(--surface), 0 0 0 4px ${hex}` : undefined,
          }}
        />
      ))}
    </div>
  );
}
