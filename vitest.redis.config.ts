import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/redis.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
