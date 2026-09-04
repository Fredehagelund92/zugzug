import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TenantProvider } from "../src/lib/tenant-context";
import { tenantFixture } from "./tenant-fixture";

/* The Scans page is the only place the workspace can see whether background
 * scanning is actually running. It used to render nothing at all when
 * /sources/scan-status failed — indistinguishable from "no schedule set" — and
 * a refused schedule change looked as if it had taken. */

const { apiFetch, scanSources, setPreferences, toast, prefs } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  scanSources: vi.fn(),
  setPreferences: vi.fn(),
  toast: vi.fn(),
  prefs: {
    scanSchedule: "daily" as string | null,
    requireSecondPublisher: false,
    autoPublishEnabled: false,
  },
}));

vi.mock("../src/api", () => ({ apiFetch }));
vi.mock("../src/components/Toast", () => ({ toast }));
vi.mock("../src/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store")>();
  return {
    ...actual,
    usePreferences: () => prefs,
    setPreferences,
    scanSources,
    invalidate: { ...actual.invalidate, scans: vi.fn() },
  };
});

import { Scans } from "../src/routes/settings/Scans";

const STATUS = { lastScanAt: null, sourceCount: 2, unmappedCount: 7 };

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, statusText: "OK", json: async () => body });
}

beforeEach(() => {
  vi.clearAllMocks();
  prefs.scanSchedule = "daily";
  apiFetch.mockImplementation(() => ok(STATUS));
});

function renderScans(role: "admin" | "editor" | "viewer" = "admin") {
  return render(
    <TenantProvider value={tenantFixture(role)}>
      <Scans />
    </TenantProvider>,
  );
}

describe("Scans settings", () => {
  it("shows the live status once it loads", async () => {
    renderScans();
    expect(await screen.findByText(/last scan never/)).toBeInTheDocument();
    expect(screen.getByText(/2 sources/)).toBeInTheDocument();
    expect(screen.getByText(/7 unmapped/)).toBeInTheDocument();
  });

  it("shows the settled state when a single source has nothing unmapped", async () => {
    apiFetch.mockImplementation(() => ok({ lastScanAt: null, sourceCount: 1, unmappedCount: 0 }));
    renderScans();
    expect(await screen.findByText(/1 source/)).toBeInTheDocument();
    expect(screen.queryByText(/· 0 unmapped/)).toBeNull();
  });

  it("reports how many sources a manual scan covered", async () => {
    scanSources.mockResolvedValue(2);
    renderScans();
    fireEvent.click(await screen.findByRole("button", { name: /scan now/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Scanned 2 sources."));
  });

  it("says so when the manual scan fails", async () => {
    scanSources.mockRejectedValue(new Error("no warehouse attached"));
    renderScans();
    fireEvent.click(await screen.findByRole("button", { name: /scan now/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("no warehouse attached", "error"));
  });

  it("hides Scan now from a viewer, who can't run one", async () => {
    renderScans("viewer");
    await screen.findByText(/last scan never/);
    expect(screen.queryByRole("button", { name: /scan now/i })).toBeNull();
  });

  it("surfaces a refused schedule change instead of leaving the control looking saved", async () => {
    setPreferences.mockRejectedValue(new Error("admin required"));
    renderScans();
    await screen.findByText(/last scan never/);
    fireEvent.click(screen.getByRole("button", { name: "Hourly" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Couldn't update schedule: admin required", "error"),
    );
  });

  it("shows the status error with a Retry that re-requests", async () => {
    apiFetch.mockImplementationOnce(() =>
      Promise.resolve({ ok: false, status: 503, statusText: "Service Unavailable" }),
    );
    renderScans();
    expect(await screen.findByText(/Couldn’t load scan status — 503/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText(/last scan never/)).toBeInTheDocument();
  });

  it("shows a skeleton while the status of a scheduled workspace is still loading", () => {
    apiFetch.mockImplementation(() => new Promise(() => {}));
    const { container } = renderScans();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});
