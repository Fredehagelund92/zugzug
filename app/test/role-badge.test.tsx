import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoleBadge } from "../src/components/RoleBadge";

describe("RoleBadge", () => {
  test("viewer renders read-only badge", () => {
    render(<RoleBadge role="viewer" />);
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });

  test("admin renders admin badge", () => {
    render(<RoleBadge role="admin" />);
    expect(screen.getByText(/admin/i)).toBeInTheDocument();
  });

  test("editor renders nothing", () => {
    const { container } = render(<RoleBadge role="editor" />);
    expect(container.firstChild).toBeNull();
  });
});
