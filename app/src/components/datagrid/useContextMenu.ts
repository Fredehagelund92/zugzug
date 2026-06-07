import { useCallback, useEffect, useState } from "react";

export type ContextSurface =
  | { kind: "cell"; rowKey: string; field: string }
  | { kind: "header"; field: string }
  | { kind: "row-num"; rowKey: string };

export interface ContextMenuState {
  surface: ContextSurface;
  x: number;
  y: number;
}

export function useContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const cell = target.closest<HTMLElement>("[data-cell]");
    const header = target.closest<HTMLElement>("[data-header]");
    const rowNum = target.closest<HTMLElement>("[data-row-num]");
    let surface: ContextSurface | null = null;
    if (cell?.dataset.cell) {
      const sep = cell.dataset.cell.indexOf("::");
      if (sep > 0) {
        surface = {
          kind: "cell",
          rowKey: cell.dataset.cell.slice(0, sep),
          field: cell.dataset.cell.slice(sep + 2),
        };
      }
    } else if (header?.dataset.header) {
      surface = { kind: "header", field: header.dataset.header };
    } else if (rowNum?.dataset.rowNum) {
      surface = { kind: "row-num", rowKey: rowNum.dataset.rowNum };
    }
    if (!surface) return;
    e.preventDefault();
    setMenu({ surface, x: e.clientX, y: e.clientY });
  }, []);

  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[role="menu"]')) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [menu, close]);

  return { menu, onContextMenu, close };
}
