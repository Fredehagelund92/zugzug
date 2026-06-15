export const WORKSPACE_COLORS = [
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#10b981",
  "#14b8a6",
  "#3b82f6",
  "#64748b",
] as const;

export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];

/** 2-letter initials from a workspace label. */
export function workspaceInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0]! + words[1][0]!).toUpperCase();
}

/** Resolve a workspace color — falls back to indigo for null or unknown values. */
export function workspaceColor(color: string | null): string {
  if (color && (WORKSPACE_COLORS as readonly string[]).includes(color)) return color;
  return WORKSPACE_COLORS[0];
}
