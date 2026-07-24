import type { TreeNode } from "./catalog-tree";

const KIND_LABEL: Record<TreeNode["kind"], string> = {
  connection: "Connection",
  database: "Database",
  schema: "Schema",
  table: "Table",
};

function cards(node: TreeNode): Array<{ big: number; cap: string }> {
  if (node.kind === "schema") return [{ big: node.count ?? node.children.length, cap: "tables" }];
  if (node.kind === "database")
    return [
      { big: node.count ?? node.children.length, cap: "schemas" },
      ...(node.children.length > 0
        ? [{ big: node.children.reduce((a, s) => a + (s.count ?? 0), 0), cap: "tables" }]
        : []),
    ];
  // connection
  const dbs = node.children;
  return [
    { big: dbs.length, cap: "databases" },
    { big: dbs.reduce((a, d) => a + (d.count ?? 0), 0), cap: "schemas" },
  ];
}

const LEAD: Record<TreeNode["kind"], string> = {
  connection:
    "Expand this connection to browse its databases, or filter to jump straight to a table.",
  database: "A database groups schemas. Open one to see its tables.",
  schema: "Open a table to view its columns and map source values to records.",
  table: "",
};

export function NodeOverview({ node }: { node: TreeNode }) {
  return (
    <div>
      <div className="border-b border-line bg-surface px-6 pb-3.5 pt-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="font-display text-[22px] font-semibold tracking-tight text-ink">
            {node.name}
          </h2>
          <span className="rounded-pill border border-line px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-3">
            {KIND_LABEL[node.kind]}
          </span>
        </div>
      </div>
      <div className="px-6 py-6">
        <p className="mb-5 max-w-xl text-ink-2">{LEAD[node.kind]}</p>
        <div className="grid max-w-2xl grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
          {cards(node).map((c) => (
            <div key={c.cap} className="rounded-lg border border-line bg-surface p-4">
              <div className="font-display text-[26px] font-semibold tracking-tight text-ink">
                {c.big >= 120 ? "120+" : c.big}
              </div>
              <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3">
                {c.cap}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
