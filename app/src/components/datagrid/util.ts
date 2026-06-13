// Shared internal helpers for DataGrid pieces (header / body / row).

// Escape a string for use inside a double-quoted CSS attribute selector.
export const attrEsc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// Brief accent-wash on a cell after a bulk action (paste-fill / clear-range)
// so the user sees what the keystroke just did. Deferred to the next frame
// so React has rendered the new value first.
export function flashCell(rk: string, field: string): void {
  requestAnimationFrame(() => {
    const sel = `[data-cell="${attrEsc(`${rk}::${field}`)}"]`;
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return;
    el.classList.remove("zz-row-flash");
    void el.offsetWidth;
    el.classList.add("zz-row-flash");
    window.setTimeout(() => el.classList.remove("zz-row-flash"), 1700);
  });
}
