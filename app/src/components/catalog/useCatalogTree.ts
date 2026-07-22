import { useEffect, useRef, useState } from "react";
import { fetchWarehouseDatabases, fetchWarehouseInfo } from "../../api";
import { fetchColumns, listSchemas, listTablesInSchema } from "../../store";
import { tintForSchema, type TreeNode } from "./catalog-tree";

const CONN_META: Record<string, { name: string; glyph: string }> = {
  duckdb: { name: "MotherDuck", glyph: "🦆" },
  snowflake: { name: "Snowflake", glyph: "◆" },
};

export function useCatalogTree() {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const rootsRef = useRef<TreeNode[]>([]);
  rootsRef.current = roots;

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchWarehouseInfo(), fetchWarehouseDatabases()])
      .then(([info, dbs]) => {
        if (cancelled) return;
        const meta = CONN_META[info.adapter] ?? { name: info.adapter, glyph: "▦" };
        const conn: TreeNode = {
          id: "conn",
          kind: "connection",
          name: meta.name,
          glyph: meta.glyph,
          count: dbs.length,
          depth: 0,
          childrenLoaded: true,
          children: dbs.map((d) => ({
            id: `conn/${d.id}`,
            kind: "database" as const,
            name: d.databaseName,
            count: typeof d.schemaCount === "number" ? d.schemaCount : null,
            depth: 1,
            childrenLoaded: false,
            children: [],
          })),
        };
        setRoots([conn]);
        setOpen(new Set(["conn"]));
      })
      .catch(() => setRoots([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = (id: string, fn: (n: TreeNode) => TreeNode) => {
    const walk = (nodes: TreeNode[]): TreeNode[] =>
      nodes.map((n) => (n.id === id ? fn(n) : { ...n, children: walk(n.children) }));
    setRoots((r) => walk(r));
  };

  const mark = (id: string, on: boolean) =>
    setLoadingIds((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const dbIdOf = (id: string) => id.split("/")[1]!;

  const loadChildren = async (node: TreeNode) => {
    if (node.childrenLoaded) return;
    mark(node.id, true);
    try {
      if (node.kind === "database") {
        const schemas = await listSchemas(dbIdOf(node.id));
        patch(node.id, (n) => ({
          ...n,
          childrenLoaded: true,
          count: schemas.length,
          children: schemas.map((s) => ({
            id: `${n.id}/${s.schema}`,
            kind: "schema" as const,
            name: s.schema,
            count: s.tables,
            tint: tintForSchema(s.schema),
            depth: 2,
            childrenLoaded: false,
            children: [],
          })),
        }));
      } else if (node.kind === "schema") {
        const schema = node.name;
        const tables = await listTablesInSchema(dbIdOf(node.id), schema);
        patch(node.id, (n) => ({
          ...n,
          childrenLoaded: true,
          children: tables.map((tbl) => ({
            // tbl.table is "schema.tablename" (e.g. "authco.users")
            // node id becomes: conn/<dbId>/<schema>/authco.users
            id: `${n.id}/${tbl.table}`,
            kind: "table" as const,
            // strip the "schema." prefix for display name
            name: tbl.table.split(".").slice(1).join("."),
            count: tbl.columns.length,
            columns: tbl.columns,
            depth: 3,
            childrenLoaded: true,
            children: [],
          })),
        }));
      }
    } finally {
      mark(node.id, false);
    }
  };

  const toggle = (id: string) => {
    const isOpen = open.has(id);
    setOpen((s) => {
      const next = new Set(s);
      if (isOpen) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!isOpen) {
      const node = findNode(rootsRef.current, id);
      if (node && !node.childrenLoaded && !loadingIds.has(id)) void loadChildren(node);
    }
  };

  const ensureColumns = async (tableId: string) => {
    const node = findNode(rootsRef.current, tableId);
    if (!node || node.columns) return;
    // Table id: conn/<dbId>/<schema>/<schema.table>
    // Last segment (index 3) is the "schema.table" string fetchColumns expects.
    const tablePath = tableId.split("/").slice(3).join("/");
    const cols = await fetchColumns(dbIdOf(tableId), tablePath);
    patch(tableId, (n) => ({ ...n, columns: cols.map((c) => c.name) }));
  };

  return { roots, open, loadingIds, toggle, ensureColumns };
}

function findNode(roots: TreeNode[], id: string): TreeNode | null {
  const stack = [...roots];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.id === id) return n;
    stack.push(...n.children);
  }
  return null;
}
