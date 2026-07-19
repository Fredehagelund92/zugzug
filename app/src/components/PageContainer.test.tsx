import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PageContainer } from "./PageContainer";

describe("PageContainer", () => {
  it("renders children", () => {
    const { getByText } = render(<PageContainer>hello</PageContainer>);
    expect(getByText("hello")).toBeTruthy();
  });

  it("is centered and padded", () => {
    const { container } = render(<PageContainer>x</PageContainer>);
    const cls = container.firstElementChild!.className;
    expect(cls).toContain("mx-auto");
    expect(cls).toContain("w-full");
    expect(cls).toContain("p-4");
    expect(cls).toContain("md:p-8");
  });

  it("defaults to the --wide cap (1320)", () => {
    const { container } = render(<PageContainer>x</PageContainer>);
    expect(container.firstElementChild!.className).toContain("max-w-[var(--wide)]");
  });

  it("max='doc' uses the narrow --doc cap (1040)", () => {
    const { container } = render(<PageContainer max="doc">x</PageContainer>);
    const cls = container.firstElementChild!.className;
    expect(cls).toContain("max-w-[var(--doc)]");
    expect(cls).not.toContain("max-w-[var(--wide)]");
  });

  it("max='full' removes the width cap", () => {
    const { container } = render(<PageContainer max="full">x</PageContainer>);
    const cls = container.firstElementChild!.className;
    expect(cls).not.toContain("max-w-[var(--wide)]");
    expect(cls).not.toContain("max-w-[var(--doc)]");
  });

  it("merges a custom className", () => {
    const { container } = render(<PageContainer className="space-y-6">x</PageContainer>);
    expect(container.firstElementChild!.className).toContain("space-y-6");
  });

  it("forwards arbitrary div attributes", () => {
    const { getByTestId } = render(<PageContainer data-testid="page" />);
    expect(getByTestId("page")).toBeTruthy();
  });
});
