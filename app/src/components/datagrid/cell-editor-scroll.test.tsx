import { describe, it, expect } from "vitest";
import { act } from "@testing-library/react";
import { ARM_DELAY_MS } from "../AnchoredPopover";
import { renderGrid } from "./test-kit/render-grid";
import { makeColumns, type Row } from "./test-kit/fixtures";
import type { ColumnDef } from "./types";

/* Close-on-scroll for the three popover cell editors (#197).
 *
 * Scrolling the page under an open editor now closes it instead of dragging it
 * across the screen. The behaviour that matters — and that would silently
 * destroy a user's typing if it regressed — is what each editor does with an
 * in-progress edit on the way out. Each editor must match its own outside-click
 * semantics exactly: SelectCell and LinkedCell discard, DateCell commits the
 * typed value. */

function columns(): ColumnDef<Row>[] {
  return [
    ...makeColumns(),
    { field: "due", label: "Due", config: { type: "date" }, editable: true },
    {
      field: "owner",
      label: "Owner",
      config: {
        type: "linked",
        targetRefTableId: "users",
        displayFields: ["label"],
        candidates: [
          { key: "u1", label: "Ada" },
          { key: "u2", label: "Linus" },
        ],
      },
      editable: true,
    },
  ];
}

/** Lets the editors' arming delay elapse, after which a scroll dismisses. */
async function armed(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ARM_DELAY_MS + 20));
  });
}

/** A scroll of the page underneath the editor, not of the editor's own list. */
async function scrollPage(): Promise<void> {
  await act(async () => {
    document.body.dispatchEvent(new Event("scroll", { bubbles: false }));
  });
}

const pop = () => document.querySelector<HTMLElement>("div.shadow-pop");

describe("cell editors close on scroll", () => {
  it("SelectCell discards on scroll, exactly as it does on outside click", async () => {
    const g = renderGrid({ columns: columns() });
    await g.user.dblClick(g.cellAt(0, "region"));
    expect(pop()).not.toBeNull();

    await armed();
    await scrollPage();

    expect(pop()).toBeNull();
    // Nothing is written: the search box is a filter, not a value.
    expect(g.onCommit).not.toHaveBeenCalled();
  });

  it("LinkedCell discards on scroll, exactly as it does on outside click", async () => {
    const g = renderGrid({ columns: columns() });
    await g.user.dblClick(g.cellAt(0, "owner"));
    expect(pop()).not.toBeNull();

    await armed();
    await scrollPage();

    expect(pop()).toBeNull();
    expect(g.onCommit).not.toHaveBeenCalled();
  });

  it("DateCell commits the typed value on scroll, exactly as it does on outside click", async () => {
    const g = renderGrid({ columns: columns() });
    await g.user.dblClick(g.cellAt(0, "due"));
    const input = document.activeElement as HTMLInputElement;
    await g.user.type(input, "2026-03-04");

    await armed();
    await scrollPage();

    // This is the assertion that protects users' typing: a date typed but not
    // yet confirmed must survive scrolling away.
    expect(g.onCommit).toHaveBeenCalledWith("r0", "due", "2026-03-04");
  });

  it("DateCell does not commit when its own input scrolls while typing", async () => {
    // DateCell renders its input in the cell, not in the portal. A text input
    // fires a capture-phase scroll on itself once its content overflows — which
    // a narrow date column does well before YYYY-MM-DD is fully typed. That
    // must not read as "the page moved underneath the editor", because this
    // editor commits on the way out: it would write a half-typed date.
    const g = renderGrid({ columns: columns() });
    await g.user.dblClick(g.cellAt(0, "due"));
    const input = document.activeElement as HTMLInputElement;
    await g.user.type(input, "2026-03");

    await armed();
    await act(async () => {
      input.dispatchEvent(new Event("scroll", { bubbles: false }));
    });

    expect(g.onCommit).not.toHaveBeenCalled();
    expect(pop()).not.toBeNull();
  });

  it("a scroll in the moment the editor opened does not close it", async () => {
    // Each editor focuses its input in an effect that runs after the popover
    // subscribes; the browser may scroll a half-visible cell into view, which
    // would otherwise open and close the editor in the same moment.
    const g = renderGrid({ columns: columns() });
    await g.user.dblClick(g.cellAt(0, "region"));

    await scrollPage();

    expect(pop()).not.toBeNull();
  });
});
