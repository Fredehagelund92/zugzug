export type NodeKind = "connection" | "database" | "schema" | "table";

export interface TreeNode {
  id: string;
  kind: NodeKind;
  name: string;
  count: number | null;
  tint?: string;
  glyph?: string;
  depth: number;
  childrenLoaded: boolean;
  children: TreeNode[];
  columns?: string[];
  unreachable?: boolean;
  /** Loading this node's children failed — not the same as having none. */
  loadFailed?: boolean;
}

const TINTS = [
  "rose",
  "amber",
  "mint",
  "teal",
  "indigo",
  "violet",
  "slate",
  "coral",
  "sky",
  "lime",
] as const;

/** Deterministic tint per schema name so a schema keeps its color across renders. */
export function tintForSchema(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `var(--tint-${TINTS[h % TINTS.length]})`;
}

export function flattenVisible(roots: TreeNode[], open: Set<string>): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.children.length && open.has(n.id)) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

export function nodeById(roots: TreeNode[], id: string): TreeNode | null {
  const stack = [...roots];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.id === id) return n;
    stack.push(...n.children);
  }
  return null;
}
