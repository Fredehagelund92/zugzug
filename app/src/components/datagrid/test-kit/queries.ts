function parseCell(el: Element): { rowKey: string; field: string } {
  const data = el.getAttribute("data-cell") ?? "";
  const idx = data.indexOf("::");
  return { rowKey: data.slice(0, idx), field: data.slice(idx + 2) };
}

export function cellAt(container: HTMLElement, rowKey: string, field: string): HTMLElement {
  const sel = `[data-cell="${CSS.escape(`${rowKey}::${field}`)}"]`;
  const el = container.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`cellAt: no cell for ${rowKey}::${field}`);
  return el;
}

export function cursorCell(container: HTMLElement): { rowKey: string; field: string } | null {
  const el = container.querySelector('[role="gridcell"][aria-selected="true"]');
  return el ? parseCell(el) : null;
}

export function selectedCells(container: HTMLElement): Array<{ rowKey: string; field: string }> {
  const els = Array.from(container.querySelectorAll('[role="gridcell"][data-in-range="true"], [role="gridcell"][aria-selected="true"]'));
  // de-dupe (cursor cell may also be in-range)
  const seen = new Set<string>();
  const out: Array<{ rowKey: string; field: string }> = [];
  for (const el of els) {
    const key = el.getAttribute("data-cell") ?? "";
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parseCell(el));
  }
  return out;
}

export function editingCell(container: HTMLElement): { rowKey: string; field: string } | null {
  // the active editor (input / contenteditable) is rendered inside the editing cell
  const editor = container.querySelector('[role="gridcell"] input, [role="gridcell"] [contenteditable="true"]');
  const cell = editor?.closest('[role="gridcell"]');
  return cell ? parseCell(cell) : null;
}
