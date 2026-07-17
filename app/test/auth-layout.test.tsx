import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuthLayout } from "../src/components/auth/AuthLayout";

describe("AuthLayout", () => {
  it("renders the brand wordmark and its children", () => {
    render(
      <AuthLayout>
        <button>Sign in</button>
      </AuthLayout>,
    );
    expect(screen.getByText(/Zug Zug/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows the brand thesis headline", () => {
    render(<AuthLayout><span>x</span></AuthLayout>);
    expect(screen.getByText(/One table/i)).toBeInTheDocument();
  });
});
