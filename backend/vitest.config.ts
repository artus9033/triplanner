import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "backend",
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    // Live tests make real API calls with web search.
    hookTimeout: 120_000,
  },
});
