import { defineConfig } from "@playwright/test";

const reuseExistingServer = !process.env.CI;

export default defineConfig({
  testDir: "./consumer-e2e",
  testMatch: "**/*.playwright.ts",
  outputDir: "test-results/consumer",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  failOnFlakyTests: true,
  retries: 0,
  workers: 1,
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: "playwright-report/consumer", open: "never" }]]
    : "line",
  expect: { timeout: 10_000 },
  use: {
    browserName: "chromium",
    locale: "zh-CN",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      name: "b-pc-production-preview",
      command: "pnpm preview --host 127.0.0.1 --port 4310 --strictPort",
      port: 4310,
      reuseExistingServer,
      timeout: 120_000,
    },
    {
      name: "b-mobile-production-preview",
      command: "pnpm -C ../webb preview --host 127.0.0.1 --port 4311 --strictPort",
      port: 4311,
      reuseExistingServer,
      timeout: 120_000,
    },
    {
      name: "c-mobile-production-preview",
      command: "pnpm -C ../webc preview --host 127.0.0.1 --port 4312 --strictPort",
      port: 4312,
      reuseExistingServer,
      timeout: 120_000,
    },
  ],
});
