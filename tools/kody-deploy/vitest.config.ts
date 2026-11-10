import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { globalSetup: ["../../vitest.global-setup.ts"], include: ["src/**/*.test.ts"], coverage: { provider: "v8", reporter: ["json", "text"] } },
});
