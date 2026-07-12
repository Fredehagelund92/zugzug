import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { OpenTabsProvider } from "../src/lib/open-tabs";

const deleteDimension = vi.hoisted(() => vi.fn(async () => {}));
const canEditFlag = vi.hoisted(() => ({ value: true }));

vi.mock("../src/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store")>();
  return {
    ...actual,
    useDimensions: () => [
      { id: "brand", dimension: "Brand", rows: 5295, color: null },
      { id: "a", dimension: "A", rows: 2, color: null },
    ],
    useCanEdit: () => canEditFlag.value,
    deleteDimension,
  };
});

vi.mock("../src/components/Toast", () => ({ toast: vi.fn() }));

async function renderStrip() {
  const { TableTabStrip } = await import("../src/components/TableTabStrip");
  const { useOpenTabs } = await import("../src/lib/open-tabs");
  function Opener() {
    const { openTab } = useOpenTabs();
    return <button data-testid="open-brand" onClick={() => openTab("brand")} />;
  }
  const utils = render(
    <MemoryRouter>
      <OpenTabsProvider slug={`t-${Math.random().toString(36).slice(2, 8)}`}>
        <TableTabStrip />
        <Opener />
      </OpenTabsProvider>
    </MemoryRouter>,
  );
  act(() => {
    fireEvent.click(screen.getByTestId("open-brand"));
  });
  return utils;
}

beforeEach(() => {
  localStorage.clear();
  deleteDimension.mockClear();
  canEditFlag.value = true;
});

describe("delete table from the tab strip", () => {
  test("right-click opens the menu; Delete requires typing the name; confirm calls the store and closes the tab", async () => {
    await renderStrip();
    const tab = await screen.findByRole("tab", { name: /brand/i });

    act(() => {
      fireEvent.contextMenu(tab);
    });
    const del = await screen.findByRole("menuitem", { name: /delete table/i });
    act(() => {
      fireEvent.click(del);
    });

    // Dialog with typed confirmation: button disabled until the exact name.
    const confirm = await screen.findByRole("button", { name: /delete table/i });
    expect(confirm).toBeDisabled();
    const phrase = screen.getByPlaceholderText("Brand");
    act(() => {
      fireEvent.change(phrase, { target: { value: "Brand" } });
    });
    expect(confirm).toBeEnabled();

    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(deleteDimension).toHaveBeenCalledWith("brand"));
    // The tab is gone once the delete resolves.
    await waitFor(() => expect(screen.queryByRole("tab", { name: /brand/i })).toBeNull());
  });

  test("read-only users get no Delete item", async () => {
    canEditFlag.value = false;
    await renderStrip();
    const tab = await screen.findByRole("tab", { name: /brand/i });

    act(() => {
      fireEvent.contextMenu(tab);
    });

    // Menu opens (Close tab item present)
    await screen.findByRole("menuitem", { name: /close tab/i });
    // But no Delete table item
    expect(screen.queryByRole("menuitem", { name: /delete table/i })).toBeNull();
  });
});
