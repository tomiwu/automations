import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { fileParallelism: false, globalSetup: ["../../vitest.global-setup.ts", "src/global-setup.ts"], include: ["src/**/*.test.ts"], coverage: { provider: "v8", reporter: ["json", "text"] } },
});
