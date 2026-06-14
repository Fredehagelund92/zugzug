import { describe, test, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { WarehouseCard } from "../src/components/warehouse/WarehouseCard";

const baseProps = {
  onVerify: vi.fn(),
  onEditCredentials: vi.fn(),
  onDelete: vi.fn(),
  canEditCredentials: true,
};

describe("WarehouseCard", () => {
  test("renders 'not configured' pill when connection is null", () => {
    const { container } = render(<WarehouseCard connection={null} {...baseProps} />);
    expect(container.textContent).toContain("not configured");
  });

  test("renders 'unverified' pill for a fresh connection", () => {
    const { container } = render(
      <WarehouseCard
        connection={{
          id: "wc_1",
          adapter: "motherduck",
          label: "Prod",
          credentialsVersion: 1,
          lastVerifiedAt: null,
          lastVerifyError: null,
        }}
        {...baseProps}
      />,
    );
    expect(container.textContent).toContain("unverified");
  });

  test("renders 'reachable' pill on successful verify", () => {
    const { container } = render(
      <WarehouseCard
        connection={{
          id: "wc_1",
          adapter: "motherduck",
          label: "Prod",
          credentialsVersion: 1,
          lastVerifiedAt: new Date().toISOString(),
          lastVerifyError: null,
        }}
        {...baseProps}
      />,
    );
    expect(container.textContent).toContain("reachable");
  });

  test("renders error string when lastVerifyError set", () => {
    const { container } = render(
      <WarehouseCard
        connection={{
          id: "wc_1",
          adapter: "motherduck",
          label: "Prod",
          credentialsVersion: 1,
          lastVerifiedAt: null,
          lastVerifyError: "Auth failed",
        }}
        {...baseProps}
      />,
    );
    expect(container.textContent).toContain("Auth failed");
  });

  test("disables Edit credentials when canEditCredentials=false (viewer)", () => {
    const { container } = render(
      <WarehouseCard
        connection={{
          id: "wc_1",
          adapter: "motherduck",
          label: "Prod",
          credentialsVersion: 1,
          lastVerifiedAt: null,
          lastVerifyError: null,
        }}
        {...baseProps}
        canEditCredentials={false}
      />,
    );
    const btn = container.querySelector('button[data-action="edit-credentials"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
