import "@testing-library/jest-dom/vitest";

// jsdom does not implement scrollIntoView — polyfill it so components that
// call el.scrollIntoView() don't throw in the test environment.
Element.prototype.scrollIntoView = () => {};

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
