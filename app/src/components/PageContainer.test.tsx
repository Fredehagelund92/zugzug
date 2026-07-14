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

  it("max='full' removes the width cap", () => {
    const { container } = render(<PageContainer max="full">x</PageContainer>);
    expect(container.firstElementChild!.className).not.toContain("max-w-[var(--wide)]");
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
