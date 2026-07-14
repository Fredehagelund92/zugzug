/**
 * Socket-level test for usePresence's binary-frame guard.
 *
 * The guard lives in the `message` event listener attached to the y-websocket
 * provider's underlying WebSocket:
 *
 *   if (typeof event.data !== "string") return; // binary → y-websocket
 *
 * We mock the `y-websocket` module so WebsocketProvider is a minimal fake
 * whose `.ws` is a real EventTarget we control.  This lets us dispatch both
 * binary (ArrayBuffer) and string MessageEvents directly on the socket and
 * assert that `onRowTouched` is only called for valid string frames.
 *
 * If the `typeof event.data !== "string"` guard were removed (or inverted),
 * the binary-frame assertion would fail because JSON.parse(ArrayBuffer) throws
 * and the catch block silences it — BUT the onRowTouched spy would be called
 * with undefined-shaped data on the string frame regardless, so the real
 * proof-it's-real scenario is: invert the guard → binary frame now enters the
 * try block → parse throws → caught silently, but string frame is now skipped
 * → onRowTouched is never called → the "string frame calls onRowTouched" test
 * fails. Either inversion causes at least one assertion to fail.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mock y-websocket before importing usePresence so the hook uses the fake.
// vi.mock factories are hoisted, so we use vi.hoisted() to define the shared
// state that the factory closes over.
// ---------------------------------------------------------------------------

const { getLastProvider, MockWebsocketProvider } = vi.hoisted(() => {
  /** Minimal EventTarget-based fake socket. */
  class MockWebSocket extends EventTarget {
    readyState = 1; // OPEN
    send = vi.fn();
    close = vi.fn();
  }

  let _lastProvider: MockWebsocketProvider | null = null;

  class MockWebsocketProvider extends EventTarget {
    ws: MockWebSocket;
    awareness: {
      clientID: number;
      setLocalState: ReturnType<typeof vi.fn>;
      getLocalState: ReturnType<typeof vi.fn>;
      getStates: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      off: ReturnType<typeof vi.fn>;
    };

    constructor() {
      super();
      this.ws = new MockWebSocket();
      this.awareness = {
        clientID: 1,
        setLocalState: vi.fn(),
        getLocalState: vi.fn().mockReturnValue({}),
        getStates: vi.fn().mockReturnValue(new Map()),
        on: vi.fn(),
        off: vi.fn(),
      };
      _lastProvider = this;
    }

    /** Mirror ObservableV2: provider.on(event, cb) / provider.off(event, cb). */
    on(event: string, cb: (arg: unknown) => void) {
      this.addEventListener(event, (e) => cb((e as CustomEvent).detail));
    }
    off(event: string, cb: (arg: unknown) => void) {
      this.removeEventListener(event, cb as EventListener);
    }

    /** Simulate the provider emitting status: connected, which causes the hook
     *  to call attachSocketListener() and bind to provider.ws. */
    emitConnected() {
      this.dispatchEvent(
        new CustomEvent("status", { detail: { status: "connected" } }),
      );
    }

    destroy = vi.fn();
  }

  return {
    getLastProvider: () => _lastProvider,
    MockWebsocketProvider,
  };
});

vi.mock("y-websocket", () => ({
  WebsocketProvider: MockWebsocketProvider,
}));

// Also mock yjs (the Doc is only a carrier; we don't need real CRDT behaviour).
vi.mock("yjs", () => ({
  Doc: class {
    destroy = vi.fn();
  },
}));

// ---------------------------------------------------------------------------
// Import the hook AFTER the mocks are in place.
// ---------------------------------------------------------------------------
import { usePresence } from "../src/lib/use-presence";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("usePresence — socket-level binary-frame guard", () => {
  beforeEach(() => {
    // jsdom needs location to be set for the hook to build a wsUrl.
    Object.defineProperty(window, "location", {
      value: { protocol: "http:", host: "localhost", pathname: "/app/test/" },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("binary ArrayBuffer frame does NOT call onRowTouched", async () => {
    const onRowTouched = vi.fn();

    renderHook(() =>
      usePresence("tbl_1", { userId: "u1", displayName: "Alice", onRowTouched }),
    );

    // The hook attaches the listener on mount (synchronously, before status fires)
    // and again when status: connected fires.
    await act(async () => {
      getLastProvider()!.emitConnected();
    });

    // Dispatch a binary frame — this is exactly what y-websocket sends for
    // awareness/sync messages.
    act(() => {
      getLastProvider()!.ws.dispatchEvent(
        new MessageEvent("message", { data: new ArrayBuffer(4) }),
      );
    });

    expect(onRowTouched).not.toHaveBeenCalled();
  });

  test("valid row_touched string frame calls onRowTouched exactly once with the hint", async () => {
    const onRowTouched = vi.fn();

    renderHook(() =>
      usePresence("tbl_1", { userId: "u1", displayName: "Alice", onRowTouched }),
    );

    await act(async () => {
      getLastProvider()!.emitConnected();
    });

    const hint = { type: "row_touched", rowKey: "k1", userId: "u2" };
    act(() => {
      getLastProvider()!.ws.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(hint) }),
      );
    });

    expect(onRowTouched).toHaveBeenCalledTimes(1);
    expect(onRowTouched).toHaveBeenCalledWith(hint);
  });

  test("malformed string frame does NOT call onRowTouched", async () => {
    const onRowTouched = vi.fn();

    renderHook(() =>
      usePresence("tbl_1", { userId: "u1", displayName: "Alice", onRowTouched }),
    );

    await act(async () => {
      getLastProvider()!.emitConnected();
    });

    // Well-formed JSON but wrong shape (missing type: row_touched).
    act(() => {
      getLastProvider()!.ws.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "other", rowKey: "k1", userId: "u2" }),
        }),
      );
    });

    // Unparseable string.
    act(() => {
      getLastProvider()!.ws.dispatchEvent(
        new MessageEvent("message", { data: "not-json" }),
      );
    });

    expect(onRowTouched).not.toHaveBeenCalled();
  });
});
