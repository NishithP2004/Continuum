import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => cleanup());

Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value() {} });
Object.defineProperty(globalThis, "WebGL2RenderingContext", { configurable: true, value: class WebGL2RenderingContext {} });
Object.defineProperty(globalThis, "WebGLRenderingContext", { configurable: true, value: class WebGLRenderingContext {} });
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true
  })
});
