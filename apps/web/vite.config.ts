import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 43118,
    strictPort: true
  },
  preview: {
    port: 43118,
    strictPort: true
  },
  build: {
    // Keep this at the public root: Vite's preview server intentionally does
    // not serve files from the dot-prefixed `.vite` directory.
    manifest: "vite-manifest.json"
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.test.{ts,tsx}"],
    css: true
  }
});
