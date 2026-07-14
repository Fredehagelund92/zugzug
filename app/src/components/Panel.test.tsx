import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Panel } from "./Panel";

describe("Panel", () => {
  it("renders children", () => {
    const { getByText } = render(<Panel>hello</Panel>);
    expect(getByText("hello")).toBeTruthy();
  });

  it("is a white bordered surface, no shadow", () => {
    const { container } = render(<Panel>x</Panel>);
    const el = container.firstElementChild!;
    expect(el.className).toContain("bg-surface");
    expect(el.className).toContain("border-line");
    expect(el.className).toContain("rounded-lg");
    expect(el.className).toContain("overflow-hidden");
    // Shadow signals "overlay" — an in-page Panel never casts one.
    expect(el.className).not.toContain("shadow");
  });

  it("defaults to medium padding", () => {
    const { container } = render(<Panel>x</Panel>);
    expect(container.firstElementChild!.className).toContain("p-6");
  });

  it("padding='sm' uses compact padding", () => {
    const { container } = render(<Panel padding="sm">x</Panel>);
    const cls = container.firstElementChild!.className;
    expect(cls).toContain("p-4");
    expect(cls).not.toContain("p-6");
  });

  it("padding='none' applies no padding (for tables/grids that fill the frame)", () => {
    const { container } = render(<Panel padding="none">x</Panel>);
    const cls = container.firstElementChild!.className;
    expect(cls).not.toContain("p-6");
    expect(cls).not.toContain("p-4");
    expect(cls).toContain("overflow-hidden");
  });

  it("merges a custom className", () => {
    const { container } = render(<Panel className="mt-4">x</Panel>);
    expect(container.firstElementChild!.className).toContain("mt-4");
  });

  it("forwards arbitrary div attributes", () => {
    const { getByRole } = render(<Panel role="region" aria-label="Deliveries" />);
    expect(getByRole("region").getAttribute("aria-label")).toBe("Deliveries");
  });
});
