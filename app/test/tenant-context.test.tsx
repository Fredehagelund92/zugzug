import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { TenantProvider, useTenant } from "../src/lib/tenant-context";

function Probe() {
  const t = useTenant();
  return <div data-testid="ctx">{t.slug}/{t.role}</div>;
}

// Minimal error boundary to catch render-time throws from hooks
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) throw this.state.error;
    return this.props.children;
  }
}

describe("TenantProvider", () => {
  test("exposes tenant via useTenant()", () => {
    render(
      <TenantProvider value={{ id: "t1", slug: "acme", label: "Acme", role: "admin", isSuperAdmin: false }}>
        <Probe />
      </TenantProvider>,
    );
    expect(screen.getByTestId("ctx").textContent).toBe("acme/admin");
  });

  test("throws when used outside provider", () => {
    expect(() =>
      render(
        <ErrorBoundary>
          <Probe />
        </ErrorBoundary>,
      ),
    ).toThrow(/useTenant.*outside/);
  });
});
