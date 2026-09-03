/**
 * admin-and-create-table.test.tsx
 *
 * Component tests for untested branches of:
 *   - app/src/routes/admin/Workspaces.tsx
 *   - app/src/components/CreateTableModal.tsx
 *
 * URL shape note:
 *   apiFetch("/tenants") with pathname /app/admin/... resolves to /api/admin/tenants
 *   because api.ts checks slug === "admin" → `/api/admin${path}`.
 *   PATCH /tenants/:id → /api/admin/tenants/:id
 *   POST /tenants       → /api/admin/tenants
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Workspaces } from "../../src/routes/admin/Workspaces";

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted before imports)
// ---------------------------------------------------------------------------

const mockApiFetch = vi.hoisted(() => vi.fn());
vi.mock("../../src/api", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const mockInvalidateMemberships = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockInvalidateTenantList = vi.hoisted(() => vi.fn());
const mockSubscribeInvalidate = vi.hoisted(() => vi.fn(() => () => {}));
const mockUseSources = vi.hoisted(() =>
  vi.fn(() => [] as ReturnType<typeof import("../../src/store").useSources>),
);
const mockCreateTable = vi.hoisted(() => vi.fn<() => Promise<string>>());

vi.mock("../../src/store", async (orig) => {
  const a = await orig<typeof import("../../src/store")>();
  return {
    ...a,
    initStore: vi.fn(),
    useSources: () => mockUseSources(),
    useRefTables: () => [],
    createTable: mockCreateTable,
    subscribeInvalidate: (...args: unknown[]) => mockSubscribeInvalidate(...args),
    invalidate: {
      ...a.invalidate,
      memberships: (...args: unknown[]) => mockInvalidateMemberships(...args),
      tenantList: (...args: unknown[]) => mockInvalidateTenantList(...args),
    },
  };
});

// useNavLinks needs a router context — stub minimally.
vi.mock("../../src/lib/use-tenant-navigate", () => ({
  useNavLinks: () => ({ sources: "/sources" }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ok Response whose .json() resolves to `body`. */
function okJson(body: unknown) {
  return Promise.resolve({
    ok: true,
    json: async () => body,
  } as Response);
}

/** Render Workspaces inside a MemoryRouter on the admin path. */
function renderWorkspaces() {
  // apiFetch reads window.location.pathname to derive the slug.
  // /app/admin/workspaces → slug "admin" → /api/admin/...
  window.history.pushState({}, "", "/app/admin/workspaces");
  return render(
    <MemoryRouter>
      <Workspaces />
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockSubscribeInvalidate.mockReturnValue(() => {});
  // Default: never-settling fetch so tests that need specific data override it.
  mockApiFetch.mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
  window.history.pushState({}, "", "/");
});

// ===========================================================================
// Admin / Workspaces
// ===========================================================================

describe("admin/Workspaces — populated list", () => {
  it("renders both workspace rows when GET returns 2 workspaces", async () => {
    const workspaces = [
      {
        id: "ws-1",
        slug: "alpha",
        label: "Alpha Team",
        color: "#ff0000",
        member_count: 3,
      },
      {
        id: "ws-2",
        slug: "beta",
        label: "Beta Team",
        color: "#00ff00",
        member_count: 7,
      },
    ];

    mockApiFetch.mockReturnValue(okJson({ tenants: workspaces }));
    renderWorkspaces();

    await waitFor(() => screen.getByText("Alpha Team"));

    // Labels
    expect(screen.getByText("Alpha Team")).toBeInTheDocument();
    expect(screen.getByText("Beta Team")).toBeInTheDocument();

    // Slugs (rendered as <code>)
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();

    // Member counts
    expect(screen.getByText("3 members")).toBeInTheDocument();
    expect(screen.getByText("7 members")).toBeInTheDocument();
  });
});

describe("admin/Workspaces — inline rename", () => {
  it("click label → input appears → blur commits PATCH to /tenants/:id", async () => {
    const workspace = {
      id: "ws-1",
      slug: "alpha",
      label: "Alpha Team",
      color: null,
      member_count: 2,
    };

    // GET responds with one workspace; subsequent fetches (after invalidate) re-use same response.
    mockApiFetch.mockReturnValue(okJson({ tenants: [workspace] }));

    renderWorkspaces();

    // Wait for the row to render
    await waitFor(() => screen.getByText("Alpha Team"));

    // Click the label button to enter edit mode
    fireEvent.click(screen.getByRole("button", { name: "Alpha Team" }));

    // Input should appear with the current label pre-filled
    const input = screen.getByDisplayValue("Alpha Team");
    expect(input).toBeInTheDocument();

    // Change the value and blur to commit
    fireEvent.change(input, { target: { value: "Alpha Renamed" } });

    // PATCH call
    mockApiFetch.mockReturnValue(Promise.resolve({ ok: true } as Response));

    fireEvent.blur(input);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/tenants/ws-1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ label: "Alpha Renamed" }),
        }),
      );
    });
  });
});

describe("admin/Workspaces — create workspace", () => {
  it("a slug the server would reject shows an inline error and fires no request", async () => {
    mockApiFetch.mockImplementation((path: string, opts?: RequestInit) => {
      if (!opts || opts.method === undefined || opts.method === "GET")
        return okJson({ tenants: [] });
      return Promise.resolve({ ok: true } as Response);
    });

    renderWorkspaces();
    await waitFor(() => screen.getByText("No workspaces yet"));

    fireEvent.click(screen.getByRole("button", { name: /\+ new workspace/i }));
    // Hyphens are outside the server's ^[a-z][a-z0-9_]{0,20}$ address shape —
    // and used to be the placeholder's own example.
    fireEvent.change(screen.getByPlaceholderText("my_workspace"), {
      target: { value: "my-workspace" },
    });
    fireEvent.change(screen.getByPlaceholderText("My Workspace"), {
      target: { value: "My Workspace" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    });

    expect(screen.getByText(/lowercase letters, digits and underscores/i)).toBeInTheDocument();
    expect(
      mockApiFetch.mock.calls.some(([, o]) => (o as RequestInit | undefined)?.method === "POST"),
    ).toBe(false);
  });

  it("+ New workspace → fill slug+label → Create → POST fires → list updates", async () => {
    const initial = [
      {
        id: "ws-1",
        slug: "alpha",
        label: "Alpha Team",
        color: null,
        member_count: 1,
      },
    ];
    const after = [
      ...initial,
      {
        id: "ws-2",
        slug: "newbie",
        label: "New Workspace",
        color: null,
        member_count: 0,
      },
    ];

    // First GET returns initial list; POST ok; second GET (triggered by invalidate) returns updated.
    let getCount = 0;
    mockApiFetch.mockImplementation((path: string, opts?: RequestInit) => {
      if (!opts || opts.method === undefined || opts.method === "GET") {
        const list = getCount === 0 ? initial : after;
        getCount++;
        return okJson({ tenants: list });
      }
      if (opts.method === "POST") {
        return Promise.resolve({ ok: true } as Response);
      }
      return Promise.resolve({ ok: true } as Response);
    });

    // subscribeInvalidate calls the callback when tenantList fires
    let tenantListCallback: (() => void) | null = null;
    mockSubscribeInvalidate.mockImplementation((key: string, fn: () => void) => {
      if (key === "tenantList") tenantListCallback = fn;
      return () => {};
    });

    renderWorkspaces();

    await waitFor(() => screen.getByText("Alpha Team"));

    // Click "+ New workspace" to show the form
    fireEvent.click(screen.getByRole("button", { name: /\+ new workspace/i }));

    // Fill in slug and label
    const slugInput = screen.getByPlaceholderText("my_workspace");
    const labelInput = screen.getByPlaceholderText("My Workspace");
    fireEvent.change(slugInput, { target: { value: "newbie" } });
    fireEvent.change(labelInput, { target: { value: "New Workspace" } });

    // Click Create workspace
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    });

    // POST should have fired to the right URL...
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/tenants",
        expect.objectContaining({ method: "POST" }),
      );
    });
    // ...with BOTH the slug and the label in the payload (a dropped label would
    // otherwise go undetected).
    const postCall = mockApiFetch.mock.calls.find(
      ([, opts]) => (opts as RequestInit | undefined)?.method === "POST",
    );
    const sentBody = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(sentBody).toMatchObject({ slug: "newbie", label: "New Workspace" });

    // Trigger the tenantList invalidate subscriber to simulate the store refresh
    await act(async () => {
      tenantListCallback?.();
    });

    // The new workspace should now appear
    await waitFor(() => {
      expect(screen.getByText("New Workspace")).toBeInTheDocument();
    });
  });
});

// ===========================================================================
// CreateTableModal — untested branches
// ===========================================================================

describe("CreateTableModal — mode picker", () => {
  it("renders all 4 mode options in the picker", async () => {
    const { CreateTableModal } = await import("../../src/components/CreateTableModal");
    render(<CreateTableModal open onClose={vi.fn()} onCreated={vi.fn()} />);

    expect(screen.getByRole("radio", { name: /empty table/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /from a column/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /from a file/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /from a lookup table/i })).toBeInTheDocument();
  });

  it("selecting 'From a column' shows the column picker panel", async () => {
    const { CreateTableModal } = await import("../../src/components/CreateTableModal");
    render(<CreateTableModal open onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("radio", { name: /from a column/i }));

    // In source mode with no sources, a message about warehouse columns appears.
    await waitFor(() => {
      expect(screen.getByText(/no warehouse columns available yet/i)).toBeInTheDocument();
    });
  });

  it("selecting 'From a file' shows the file upload panel", async () => {
    const { CreateTableModal } = await import("../../src/components/CreateTableModal");
    render(<CreateTableModal open onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("radio", { name: /from a file/i }));

    await waitFor(() => {
      expect(screen.getByText(/choose a csv file/i)).toBeInTheDocument();
    });
  });

  it("selecting 'From a lookup table' shows the external-id panel", async () => {
    const { CreateTableModal } = await import("../../src/components/CreateTableModal");
    render(<CreateTableModal open onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByRole("radio", { name: /from a lookup table/i }));

    await waitFor(() => {
      // The permanent-key warning is characteristic of the external_id panel.
      expect(screen.getByText(/the id column is permanent/i)).toBeInTheDocument();
    });
  });
});

describe("CreateTableModal — From a column picker with sources", () => {
  it("lists available sources when useSources() returns items", async () => {
    mockUseSources.mockReturnValue([
      { table: "public.orders", column: "status", scanned: true, values: 5, rows: 100 },
      { table: "public.users", column: "country", scanned: true, values: 42, rows: 1000 },
    ] as ReturnType<typeof import("../../src/store").useSources>);

    const { CreateTableModal } = await import("../../src/components/CreateTableModal");
    render(<CreateTableModal open onClose={vi.fn()} onCreated={vi.fn()} />);

    // Switch to source mode
    fireEvent.click(screen.getByRole("radio", { name: /from a column/i }));

    // The comboselect trigger should appear (placeholder text)
    await waitFor(() => {
      expect(screen.getByText(/pick a column/i)).toBeInTheDocument();
    });
  });
});

describe("CreateTableModal — discard guard", () => {
  it("closing with a dirty form (typed name) shows discard confirmation", async () => {
    const { CreateTableModal } = await import("../../src/components/CreateTableModal");
    const onClose = vi.fn();
    render(<CreateTableModal open onClose={onClose} onCreated={vi.fn()} />);

    // Type a name to make the form dirty
    fireEvent.change(screen.getByPlaceholderText("Name this table"), {
      target: { value: "My Table" },
    });

    // Click the X close button
    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    // onClose must NOT have been called yet — we should see the discard prompt
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/discard this table\?/i)).toBeInTheDocument();
  });

  it("discard prompt: 'Discard' calls onClose; 'Keep editing' dismisses the prompt", async () => {
    const { CreateTableModal } = await import("../../src/components/CreateTableModal");
    const onClose = vi.fn();
    render(<CreateTableModal open onClose={onClose} onCreated={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Name this table"), {
      target: { value: "My Table" },
    });

    // Open the discard prompt
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.getByText(/discard this table\?/i)).toBeInTheDocument();

    // "Keep editing" hides the prompt without closing
    fireEvent.click(screen.getByRole("button", { name: /keep editing/i }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText(/discard this table\?/i)).toBeNull();

    // Re-open prompt and click "Discard" — should call onClose
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    fireEvent.click(screen.getByRole("button", { name: /^discard$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closing with a clean form (no name) calls onClose immediately without prompt", async () => {
    const { CreateTableModal } = await import("../../src/components/CreateTableModal");
    const onClose = vi.fn();
    render(<CreateTableModal open onClose={onClose} onCreated={vi.fn()} />);

    // No typing — form is clean
    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/discard this table\?/i)).toBeNull();
  });
});
