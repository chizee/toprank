import "@testing-library/jest-dom/vitest";

// Node 25 exposes an experimental, path-dependent global localStorage that can
// shadow jsdom's implementation. Keep component tests independent of the Node
// invocation flags by installing the small, standards-compatible subset they
// need in every DOM test environment.
if (typeof window !== "undefined") {
  const values = new Map<string, string>();
  const localStorage: Storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(String(key)) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(String(key));
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
  };

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: localStorage,
  });
}
