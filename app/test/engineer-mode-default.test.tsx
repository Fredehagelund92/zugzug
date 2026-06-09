import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

describe("EngineerModeProvider — server default", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  test("uses server default when no localStorage preference", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useWorkspaceInfo: () => ({
          adapter: "duckdb",
          writable: false,
          canonicalMode: "postgres-export",
          warehouseDb: "analytics",
          defaultEngineerMode: true, // server says engineer mode ON by default
          allowedDomain: null,
        }),
      };
    });
    const { EngineerModeProvider, useEngineerMode } = await import("../src/lib/engineer-mode");

    function Probe() {
      const { engineer } = useEngineerMode();
      return <span data-testid="probe">{engineer ? "on" : "off"}</span>;
    }
    render(
      <EngineerModeProvider>
        <Probe />
      </EngineerModeProvider>,
    );
    // After the workspace-info effect fires, value should flip to ON
    await vi.waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("on"));
  });

  test("stored localStorage preference wins over server default", async () => {
    localStorage.setItem("zugzug:engineer-mode", "0");
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useWorkspaceInfo: () => ({
          adapter: "duckdb",
          writable: false,
          canonicalMode: "postgres-export",
          warehouseDb: "analytics",
          defaultEngineerMode: true, // server default is ON
          allowedDomain: null,
        }),
      };
    });
    const { EngineerModeProvider, useEngineerMode } = await import("../src/lib/engineer-mode");

    function Probe() {
      const { engineer } = useEngineerMode();
      return <span data-testid="probe">{engineer ? "on" : "off"}</span>;
    }
    render(
      <EngineerModeProvider>
        <Probe />
      </EngineerModeProvider>,
    );
    // Stored "0" wins; engineer stays off even though server says default ON
    expect(screen.getByTestId("probe").textContent).toBe("off");
  });

  test("setEngineer persists user choice to localStorage", async () => {
    vi.doMock("../src/store", async (orig) => {
      const real = await orig<typeof import("../src/store")>();
      return {
        ...real,
        useWorkspaceInfo: () => null, // simulate loading state
      };
    });
    const { EngineerModeProvider, useEngineerMode } = await import("../src/lib/engineer-mode");

    function Probe() {
      const { engineer, setEngineer } = useEngineerMode();
      return (
        <>
          <span data-testid="probe">{engineer ? "on" : "off"}</span>
          <button data-testid="toggle" onClick={() => setEngineer(true)}>toggle</button>
        </>
      );
    }
    render(
      <EngineerModeProvider>
        <Probe />
      </EngineerModeProvider>,
    );
    // Initial: false (no localStorage + no server default yet)
    expect(screen.getByTestId("probe").textContent).toBe("off");
    // User clicks to enable
    act(() => {
      screen.getByTestId("toggle").click();
    });
    expect(screen.getByTestId("probe").textContent).toBe("on");
    expect(localStorage.getItem("zugzug:engineer-mode")).toBe("1");
  });
});
