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

export function filterTree(
  roots: TreeNode[],
  query: string,
): { roots: TreeNode[]; openIds: Set<string>; matchCount: number } {
  const q = query.trim().toLowerCase();
  if (!q) return { roots, openIds: new Set(), matchCount: 0 };
  const openIds = new Set<string>();
  let matchCount = 0;

  const selfMatches = (n: TreeNode): boolean => {
    let hit = n.name.toLowerCase().includes(q);
    if (hit) matchCount++;
    if (n.kind === "table" && n.columns) {
      for (const c of n.columns) {
        if (c.toLowerCase().includes(q)) {
          matchCount++;
          hit = true;
        }
      }
    }
    return hit;
  };

  const prune = (n: TreeNode): TreeNode | null => {
    const keptChildren = n.children.map(prune).filter((c): c is TreeNode => c !== null);
    const self = selfMatches(n);
    if (!self && keptChildren.length === 0) return null;
    if (keptChildren.length) openIds.add(n.id);
    return { ...n, children: keptChildren };
  };

  const prunedRoots = roots.map(prune).filter((r): r is TreeNode => r !== null);
  return { roots: prunedRoots, openIds, matchCount };
}
