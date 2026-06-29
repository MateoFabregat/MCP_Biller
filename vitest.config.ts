import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Avoid real wall-clock waits from the rate limiter during tests.
    testTimeout: 15000,
  },
});
