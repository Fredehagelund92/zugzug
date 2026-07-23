import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { IconChevron } from "../Icons";
import { cx } from "../../lib/cx";
import { flattenVisible, type TreeNode } from "./catalog-tree";

const ROW = 28;

export function CatalogTree({
  roots,
  open,
  loadingIds,
  selectedId,
  onToggle,
  onSelect,
}: {
  roots: TreeNode[];
  open: Set<string>;
  loadingIds: Set<string>;
  selectedId: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rows = flattenVisible(roots, open);

  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW,
    overscan: 12,
  });

  // jsdom fallback: no layout → virtualizer returns 0 items.
  // Render all rows so RTL tests and SSR see content.
  const items = virtual.getVirtualItems();
  const useVirtual = items.length > 0;

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto px-1.5 pb-6 pt-1.5">
      <div
        className="relative w-full"
        style={useVirtual ? { height: virtual.getTotalSize() } : undefined}
      >
        {(useVirtual ? items : rows.map((_, i) => ({ index: i, start: i * ROW, key: i }))).map(
          (vi) => {
            const n = rows[vi.index]!;
            return (
              <div
                key={n.id}
                className="absolute left-0 top-0 w-full"
                style={{ height: ROW, transform: `translateY(${vi.start}px)` }}
              >
                <TreeRow
                  node={n}
                  open={open.has(n.id)}
                  loading={loadingIds.has(n.id)}
                  selected={selectedId === n.id}
                  onToggle={() => onToggle(n.id)}
                  onSelect={() => onSelect(n.id)}
                />
              </div>
            );
          },
        )}
      </div>
    </div>
  );
}

function TreeRow({
  node,
  open,
  loading,
  selected,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  open: boolean;
  loading: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const hasKids = node.kind !== "table";
  return (
    <button
      type="button"
      onClick={() => {
        if (hasKids) onToggle();
        onSelect();
      }}
      style={{ paddingLeft: 8 + node.depth * 14 }}
      className={cx(
        "relative flex h-7 w-full items-center gap-1.5 rounded-sm pr-2 text-left transition-colors",
        selected
          ? "bg-accent/15 text-ink before:absolute before:left-0 before:h-[18px] before:w-0.5 before:rounded before:bg-accent"
          : "text-ink-2 hover:bg-surface-2 hover:text-ink",
      )}
    >
      <IconChevron
        className={cx(
          "h-2.5 w-2.5 shrink-0 text-ink-3 transition-transform",
          hasKids ? (open ? "rotate-90" : "") : "opacity-0",
        )}
      />
      <NodeGlyph node={node} />
      <span className="flex-1 truncate font-mono text-[12px] tracking-tight" title={node.name}>
        {node.name}
      </span>
      {node.unreachable && (
        <span
          data-testid="offline-indicator"
          className="shrink-0 rounded-pill bg-danger-soft px-1.5 font-mono text-[10px] text-danger"
        >
          offline
        </span>
      )}
      {loading ? (
        <span className="font-mono text-[10px] text-ink-3">…</span>
      ) : (
        node.count != null && (
          <span
            className={cx(
              "shrink-0 rounded-pill px-1.5 font-mono text-[10px]",
              selected ? "bg-surface-3 text-ink-2" : "bg-surface-2 text-ink-3",
            )}
          >
            {node.count >= 120 ? "120+" : node.count}
          </span>
        )
      )}
    </button>
  );
}

function NodeGlyph({ node }: { node: TreeNode }) {
  if (node.kind === "schema") {
    return (
      <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: node.tint }} />
    );
  }
  const glyph =
    node.kind === "connection" ? (node.glyph ?? "🦆") : node.kind === "database" ? "▦" : "▤";
  return <span className="w-[15px] shrink-0 text-center text-[12px] text-ink-3">{glyph}</span>;
}
