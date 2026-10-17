import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // types.ts and the ambient declaration hold no runtime code.
      exclude: ["src/**/*.d.ts", "src/types.ts"],
      reporter: ["text"],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
