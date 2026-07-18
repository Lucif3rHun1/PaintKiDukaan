import "@testing-library/jest-dom/vitest";
import { vi, beforeEach } from "vitest";

// Mock Tauri IPC bridge — every test gets a fresh mock per suite
const mockInvoke = vi.fn();

Object.defineProperty(window, "__TAURI_INTERNALS__", {
  value: { invoke: mockInvoke },
  writable: true,
});

// Expose mock globally so tests can configure it
declare global {
  // eslint-disable-next-line no-var
  var __tauriInvokeMock: typeof mockInvoke;
}
globalThis.__tauriInvokeMock = mockInvoke;

// Reset mocks between tests
beforeEach(() => {
  mockInvoke.mockReset();
});

// Mock window.matchMedia (needed by boneyard-js dark mode hook)
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock ResizeObserver (needed by boneyard-js and other UI libs)
globalThis.ResizeObserver = class ResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
} as unknown as typeof ResizeObserver;

// Silence console noise in tests
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});
