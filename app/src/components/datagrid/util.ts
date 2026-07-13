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

// Very brief accent-wash (~200ms) after ⌘C — copy is high-frequency so the
// flash must be subtle and quick. Uses a dedicated class distinct from
// zz-row-flash (which is 1.6s and intended for post-navigation highlights).
export function flashCellCopy(rk: string, field: string): void {
  requestAnimationFrame(() => {
    const sel = `[data-cell="${attrEsc(`${rk}::${field}`)}"]`;
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return;
    el.classList.remove("zz-copy-flash");
    void el.offsetWidth;
    el.classList.add("zz-copy-flash");
    window.setTimeout(() => el.classList.remove("zz-copy-flash"), 250);
  });
}
