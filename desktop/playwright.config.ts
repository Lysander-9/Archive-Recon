import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  projects: [
    { name: "unit", testMatch: /unit\/.*\.test\.ts/ },
    { name: "electron", testMatch: /e2e\/.*\.spec\.ts/ },
  ],
});
