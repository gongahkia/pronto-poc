import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  // Local Next development compilation can exceed 30s on a shared WSL host.
  // Individual loading/error tests keep their own bounded assertions.
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    // HTTP browser fixtures use development mode. Production redirects require
    // HTTPS; the separate Render-image job builds and smokes production output.
    command: process.env.PRONTO_TEST_LOCAL_MAIL === "1" || process.env.PRONTO_E2E_DEV_SERVER === '1'
      ? "PRONTO_TEST_ALLOW_BUILD_IPC=1 pnpm dev" : "pnpm start",
    url: baseURL,
    // Never attach safe E2E tests to an unrelated, possibly live-configured server.
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
