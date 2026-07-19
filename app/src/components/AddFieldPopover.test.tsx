import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AddFieldPopover } from "./AddFieldPopover";

afterEach(cleanup);

describe("AddFieldPopover link target", () => {
  it("offers the current table as a link target, marked as self", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    render(
      <AddFieldPopover
        anchorRef={{ current: anchor }}
        onClose={() => {}}
        onSubmit={async () => {}}
        allDims={[
          { id: "regions", dimension: "Regions" },
          { id: "countries", dimension: "Countries" },
        ]}
        currentDimId="regions"
      />,
    );
    // Switch the new field's type to the linked type to reveal the picker.
    fireEvent.click(screen.getByText("Linked"));
    expect(screen.getByRole("option", { name: "Regions (this table)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Countries" })).toBeTruthy();
  });
});
