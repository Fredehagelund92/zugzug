import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageHeader } from "../src/components/PageHeader";

describe("PageHeader", () => {
  it("renders kicker, title, lede", () => {
    render(<PageHeader kicker="System" title="Workspaces" lede="Isolated environments." />);
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Workspaces" })).toBeInTheDocument();
    expect(screen.getByText("Isolated environments.")).toBeInTheDocument();
  });

  it("renders a count badge inline with the title when count is provided", () => {
    render(<PageHeader title="Workspaces" count={4} />);
    const badge = screen.getByTestId("page-header-count");
    expect(badge).toHaveTextContent("4");
  });

  it("renders the count badge when count is 0", () => {
    render(<PageHeader title="Workspaces" count={0} />);
    const badge = screen.getByTestId("page-header-count");
    expect(badge).toHaveTextContent("0");
  });

  it("does not render the count badge when count is undefined", () => {
    render(<PageHeader title="Workspaces" />);
    expect(screen.queryByTestId("page-header-count")).toBeNull();
  });

  it("renders the action slot on the right", () => {
    render(<PageHeader title="X" action={<button>Add</button>} />);
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });
});
