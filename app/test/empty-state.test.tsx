import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "../src/components/EmptyState";

describe("EmptyState", () => {
  it("renders title + body + action", () => {
    render(
      <EmptyState
        title="No workspaces yet"
        body="Workspaces isolate reconciliation environments."
        action={<button>Create one</button>}
      />,
    );
    expect(screen.getByText("No workspaces yet")).toBeInTheDocument();
    expect(screen.getByText("Workspaces isolate reconciliation environments.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create one" })).toBeInTheDocument();
  });

  it("renders secondary link below action", () => {
    render(
      <EmptyState title="X" action={<button>A</button>} secondary={<a href="/docs">Learn more</a>} />,
    );
    expect(screen.getByRole("link", { name: "Learn more" })).toBeInTheDocument();
  });

  it("renders optional glyph", () => {
    render(<EmptyState title="X" glyph={<svg data-testid="g" />} />);
    expect(screen.getByTestId("g")).toBeInTheDocument();
  });
});
