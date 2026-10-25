// jsdom has no ResizeObserver. Assigned directly (not vi.stubGlobal) so vi.unstubAllGlobals() keeps it.
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverPolyfill {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: ResizeObserverPolyfill,
    writable: true,
    configurable: true,
  });
}
