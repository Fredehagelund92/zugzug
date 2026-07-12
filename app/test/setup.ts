import "@testing-library/jest-dom/vitest";

// jsdom does not implement scrollIntoView — polyfill it so components that
// call el.scrollIntoView() don't throw in the test environment.
Element.prototype.scrollIntoView = () => {};

// jsdom returns 0×0 for every getBoundingClientRect, which means TanStack
// Virtual's scroll container has zero measurable height and the virtualizer
// renders no body rows. Stub a usable 800×600 rect so virtualized grids
// render their overscan window in tests.
const ORIG_RECT = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function () {
  const r = ORIG_RECT.call(this);
  if (r.width === 0 && r.height === 0) {
    return {
      x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600,
      width: 800, height: 600,
      toJSON: () => ({}),
    } as DOMRect;
  }
  return r;
};

// jsdom lacks ResizeObserver, which TanStack Virtual uses to detect when the
// scroll container's size becomes known. Stub it so observe() fires once
// synchronously on the next microtask with the polyfilled rect; the
// virtualizer then computes its visible window.
if (typeof globalThis.ResizeObserver === "undefined") {
  class TestResizeObserver {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.cb = cb; }
    observe(target: Element) {
      const rect = target.getBoundingClientRect();
      // Fire synchronously: tests render synchronously and query the DOM
      // immediately afterward, so async dispatch would miss them. React
      // batches the resulting setState; flushSync-style behavior isn't
      // needed because TanStack Virtual only triggers a re-render.
      this.cb(
        [
          {
            target,
            contentRect: rect,
            borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
            contentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
            devicePixelContentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
          } as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: TestResizeObserver, configurable: true, writable: true,
  });
}

// jsdom lacks IntersectionObserver (used by Triage's infinite-scroll sentinel).
// Stub it so components that call new IntersectionObserver() don't throw.
if (typeof globalThis.IntersectionObserver === "undefined") {
  class TestIntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "IntersectionObserver", {
    value: TestIntersectionObserver, configurable: true, writable: true,
  });
}

// vitest 4 + jsdom 29 on Node 26 does not expose Web Storage on globalThis
// (jsdom only attaches it to the Window instance, and vitest's populateGlobal
// allow-list omits the storage accessors). Install a minimal in-memory shim so
// tests that rely on localStorage round-trip behavior can run.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  const api: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => store.get(k) ?? null,
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => {
      store.delete(k);
    },
    setItem: (k, v) => {
      store.set(k, String(v));
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: api, configurable: true });
}
