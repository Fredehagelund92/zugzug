import { useEffect, useRef, useState } from "react";
import { fetchWarehouseDatabases, fetchWarehouseInfo } from "../../api";
import { listSchemas, listTablesInSchema } from "../../store";
import { tintForSchema, type TreeNode } from "./catalog-tree";

// Keyed by deployment engine (preferred) then adapter id. Local DuckDB and
// MotherDuck both report adapter "duckdb"; the engine field tells them apart.
const CONN_META: Record<string, { name: string; glyph: string }> = {
  motherduck: { name: "MotherDuck", glyph: "🦆" },
  duckdb: { name: "DuckDB", glyph: "🦆" },
  snowflake: { name: "Snowflake", glyph: "◆" },
};

export function useCatalogTree() {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  // A failed boot used to render as an empty tree — indistinguishable from a
  // warehouse with nothing registered. Keep the failure and offer a retry.
  const [rootsError, setRootsError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const rootsRef = useRef<TreeNode[]>([]);
  rootsRef.current = roots;

  useEffect(() => {
    let cancelled = false;
    setRootsError(null);
    Promise.all([fetchWarehouseInfo(), fetchWarehouseDatabases()])
      .then(([info, dbs]) => {
        if (cancelled) return;
        const meta = CONN_META[info.engine ?? ""] ??
          CONN_META[info.adapter] ?? { name: info.adapter, glyph: "▦" };
        const conn: TreeNode = {
          id: "conn",
          kind: "connection",
          name: meta.name,
          glyph: meta.glyph,
          count: dbs.length,
          depth: 0,
          childrenLoaded: true,
          children: [...dbs]
            .sort((a, b) =>
              a.databaseName.localeCompare(b.databaseName, undefined, { sensitivity: "base" }),
            )
            .map((d) => ({
              id: `conn/${d.id}`,
              kind: "database" as const,
              name: d.databaseName,
              count: typeof d.schemaCount === "number" ? d.schemaCount : null,
              depth: 1,
              childrenLoaded: false,
              children: [],
              unreachable: !!d.lastProbeError,
            })),
        };
        setRoots([conn]);
        setOpen(new Set(["conn"]));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRoots([]);
        setRootsError(err instanceof Error ? err.message : "Couldn't reach the warehouse.");
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

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
    patch(node.id, (n) => ({ ...n, loadFailed: false }));
    try {
      if (node.kind === "database") {
        const schemas = await listSchemas(dbIdOf(node.id));
        const sortedSchemas = [...schemas].sort((a, b) =>
          a.schema.localeCompare(b.schema, undefined, { sensitivity: "base" }),
        );
        patch(node.id, (n) => ({
          ...n,
          childrenLoaded: true,
          count: schemas.length,
          children: sortedSchemas.map((s) => ({
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
        const sortedTables = [...tables].sort((a, b) =>
          a.table.localeCompare(b.table, undefined, { sensitivity: "base" }),
        );
        patch(node.id, (n) => ({
          ...n,
          childrenLoaded: true,
          children: sortedTables.map((tbl) => ({
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
    } catch (err) {
      // A schema that failed to load must not look like an empty one.
      patch(node.id, (n) => ({ ...n, loadFailed: true }));
      throw err;
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
      if (node && !node.childrenLoaded && !loadingIds.has(id) && !node.unreachable) {
        loadChildren(node).catch((err) => console.warn("Failed to load children:", err));
      }
    }
  };

  const retry = () => setAttempt((n) => n + 1);

  return { roots, open, loadingIds, rootsError, retry, toggle };
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
