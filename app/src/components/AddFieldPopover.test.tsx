import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AddFieldPopover } from "./AddFieldPopover";

let anchor: HTMLButtonElement | null = null;
afterEach(() => {
  cleanup();
  anchor?.remove();
  anchor = null;
});

describe("AddFieldPopover link target", () => {
  it("offers the current table as a link target, marked as self", () => {
    anchor = document.createElement("button");
    document.body.appendChild(anchor);
    render(
      <AddFieldPopover
        anchorRef={{ current: anchor }}
        onClose={() => {}}
        onSubmit={async () => {}}
        allDims={[
          { id: "regions", refTable: "Regions" },
          { id: "countries", refTable: "Countries" },
        ]}
        currentRefTableId="regions"
      />,
    );
    // Switch the new field's type to the linked type to reveal the picker.
    fireEvent.click(screen.getByText("Linked"));
    // The self option carries the current refTable id; others carry their own.
    expect(screen.getByRole("option", { name: "Regions (this table)" }).getAttribute("value")).toBe(
      "regions",
    );
    expect(screen.getByRole("option", { name: "Countries" }).getAttribute("value")).toBe(
      "countries",
    );
  });
});
