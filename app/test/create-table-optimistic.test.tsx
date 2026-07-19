/**
 * Task 14: Optimistic create-table modal.
 *
 * The modal must close IMMEDIATELY on submit (before DDL resolves). The caller
 * gets a "Creating …" toast; on success onCreated(id) fires; on failure an
 * error toast with a Retry action appears.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

// ── controlled promise helpers ─────────────────────────────────────────────

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── mocks ─────────────────────────────────────────────────────────────────

// createTable is controlled per-test via a deferred.
const createTableMock = vi.hoisted(() => vi.fn<() => Promise<string>>());

vi.mock("../src/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store")>();
  return {
    ...actual,
    createTable: createTableMock,
    useSources: () => [],
    useDimensions: () => [],
  };
});

// useNavLinks needs a router — stub minimally.
vi.mock("../src/lib/use-tenant-navigate", () => ({
  useNavLinks: () => ({ sources: "/sources" }),
}));

// ── lifecycle ─────────────────────────────────────────────────────────────

beforeEach(async () => {
  createTableMock.mockReset();
  const { clearToasts } = await import("../src/components/Toast");
  act(() => clearToasts());
});

afterEach(async () => {
  const { clearToasts } = await import("../src/components/Toast");
  act(() => clearToasts());
});

// ── tests ─────────────────────────────────────────────────────────────────

describe("CreateTableModal — optimistic close", () => {
  test("modal closes BEFORE createTable resolves (optimistic)", async () => {
    const d = deferred<string>();
    createTableMock.mockReturnValue(d.promise);

    const { CreateTableModal } = await import("../src/components/CreateTableModal");
    const { ToastStack, clearToasts } = await import("../src/components/Toast");
    act(() => clearToasts());

    const onClose = vi.fn();
    render(
      <>
        <CreateTableModal open onClose={onClose} onCreated={vi.fn()} />
        <ToastStack />
      </>,
    );

    // Type a table name so the Create button is enabled.
    fireEvent.change(screen.getByPlaceholderText("Name this table"), {
      target: { value: "My Table" },
    });

    // Submit
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /create table/i }));
    });

    // Modal must be closed BEFORE the promise resolves.
    expect(onClose).toHaveBeenCalledTimes(1);

    // Clean up the dangling promise
    await act(async () => {
      d.resolve("dim-abc");
    });
  });

  test("onCreated(id) is called after the create resolves successfully", async () => {
    const d = deferred<string>();
    createTableMock.mockReturnValue(d.promise);

    const { CreateTableModal } = await import("../src/components/CreateTableModal");
    const { ToastStack, clearToasts } = await import("../src/components/Toast");
    act(() => clearToasts());

    const onCreated = vi.fn();
    render(
      <>
        <CreateTableModal open onClose={vi.fn()} onCreated={onCreated} />
        <ToastStack />
      </>,
    );

    fireEvent.change(screen.getByPlaceholderText("Name this table"), {
      target: { value: "My Table" },
    });

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /create table/i }));
    });

    // Not called yet — promise is still pending
    expect(onCreated).not.toHaveBeenCalled();

    // Resolve the background promise
    await act(async () => {
      d.resolve("dim-abc");
    });

    expect(onCreated).toHaveBeenCalledWith("dim-abc");
  });

  test("failure surfaces an error toast with the error message", async () => {
    const d = deferred<string>();
    createTableMock.mockReturnValue(d.promise);

    const { CreateTableModal } = await import("../src/components/CreateTableModal");
    const { ToastStack, clearToasts } = await import("../src/components/Toast");
    act(() => clearToasts());

    render(
      <>
        <CreateTableModal open onClose={vi.fn()} onCreated={vi.fn()} />
        <ToastStack />
      </>,
    );

    fireEvent.change(screen.getByPlaceholderText("Name this table"), {
      target: { value: "My Table" },
    });

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /create table/i }));
    });

    // Reject the create call — wrapping in act ensures React state updates flush
    await act(async () => {
      d.reject(new Error("DDL failed"));
    });

    // An error toast mentioning the failure must appear in the status region.
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText(/DDL failed/i)).toBeInTheDocument();
  });

  test("failure toast includes a Retry button that re-invokes createTable", async () => {
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    createTableMock.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);

    const { CreateTableModal } = await import("../src/components/CreateTableModal");
    const { ToastStack, clearToasts } = await import("../src/components/Toast");
    act(() => clearToasts());

    const onCreated = vi.fn();

    render(
      <>
        <CreateTableModal open onClose={vi.fn()} onCreated={onCreated} />
        <ToastStack />
      </>,
    );

    fireEvent.change(screen.getByPlaceholderText("Name this table"), {
      target: { value: "My Table" },
    });

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /create table/i }));
    });

    // First create fails
    await act(async () => {
      d1.reject(new Error("DDL failed"));
    });

    // A Retry button must be visible in the toast stack
    const retryBtn = screen.getByRole("button", { name: /retry/i });
    expect(retryBtn).toBeInTheDocument();

    // Click Retry — must invoke createTable a second time
    await act(async () => {
      fireEvent.click(retryBtn);
    });
    expect(createTableMock).toHaveBeenCalledTimes(2);

    // The second call succeeds
    await act(async () => {
      d2.resolve("dim-xyz");
    });
    expect(onCreated).toHaveBeenCalledWith("dim-xyz");
  });
});
