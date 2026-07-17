import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SuperAdminBadge } from "../src/components/admin/SuperAdminBadge";

describe("SuperAdminBadge", () => {
  test('renders the "Super-admin" label', () => {
    render(<SuperAdminBadge />);
    expect(screen.getByText("Super-admin")).toBeInTheDocument();
  });

  test("renders a span element with inline-flex display", () => {
    const { container } = render(<SuperAdminBadge />);
    const badge = container.querySelector("span");
    expect(badge).not.toBeNull();
    expect(badge?.className).toContain("inline-flex");
  });

  test("accepts an optional className prop", () => {
    const { container } = render(<SuperAdminBadge className="ml-1" />);
    const badge = container.querySelector("span");
    expect(badge?.className).toContain("ml-1");
  });
});
