import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The first test of a file boots PGlite and runs every migration, which under a full parallel run
    // can take longer than Vitest's default 5 s on a laptop, and more on a CI runner.
    testTimeout: process.env.CI ? 30_000 : 15_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
