import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TenantProvider } from "../src/lib/tenant-context";
import { tenantFixture } from "./tenant-fixture";

/* The refused-save path is covered in permission-denied-ui.test.tsx. This file
 * covers the other half of the same write: a save that succeeds has to refresh
 * the workspace, or the page keeps showing the pre-save value until reload. */

const { setPreferences, invalidateTenant, toast, prefs } = vi.hoisted(() => ({
  setPreferences: vi.fn(),
  invalidateTenant: vi.fn(),
  toast: vi.fn(),
  prefs: {
    scanSchedule: null as string | null,
    requireSecondPublisher: false,
    autoPublishEnabled: false,
  },
}));

vi.mock("../src/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store")>();
  return {
    ...actual,
    usePreferences: () => prefs,
    setPreferences,
    invalidate: { ...actual.invalidate, tenant: invalidateTenant },
  };
});
vi.mock("../src/components/Toast", () => ({ toast }));

import { Matching } from "../src/routes/settings/Matching";

beforeEach(() => {
  vi.clearAllMocks();
  prefs.autoPublishEnabled = false;
  setPreferences.mockResolvedValue(undefined);
});

function renderMatching() {
  return render(
    <TenantProvider value={tenantFixture("admin")}>
      <Matching />
    </TenantProvider>,
  );
}

describe("mapping settings", () => {
  it("turning on auto-publish saves it and refreshes the workspace", async () => {
    renderMatching();
    await userEvent.click(screen.getByLabelText("Publish exact matches on its own"));
    expect(setPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ autoPublishEnabled: true }),
    );
    await waitFor(() => expect(invalidateTenant).toHaveBeenCalledWith("acme"));
  });

  it("reflects auto-publish already being on", () => {
    prefs.autoPublishEnabled = true;
    renderMatching();
    expect(screen.getByLabelText("Publish exact matches on its own")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("falls back to a generic message when the failure carries no message", async () => {
    setPreferences.mockRejectedValue("nope");
    renderMatching();
    await userEvent.click(screen.getByLabelText("Publish exact matches on its own"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't save that setting.", "error"));
    expect(invalidateTenant).not.toHaveBeenCalled();
  });
});
