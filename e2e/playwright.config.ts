import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const root = join(import.meta.dirname, "..");
const run = join(root, ".run", "e2e");

export default defineConfig({
  testDir: "tests",
  workers: 1,
  timeout: 120_000,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5183" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // Playwright starts webServers before globalSetup, so the stale store is removed here.
      command:
        "mkdir -p .run/e2e && rm -f .run/e2e/relay.sqlite .run/e2e/relay.sqlite-wal .run/e2e/relay.sqlite-shm && pnpm --filter @sa/relay start",
      cwd: root,
      url: "http://127.0.0.1:8658/relay/healthz",
      reuseExistingServer: false,
      env: { PORT: "8658", RELAY_DB: join(run, "relay.sqlite"), RELAY_ADMIN_TOKEN: "e2e-token" },
    },
    {
      command: "pnpm --filter @sa/ops-sim start",
      cwd: root,
      url: "http://127.0.0.1:8659/sim/healthz",
      reuseExistingServer: false,
      env: { PORT: "8659" },
    },
    {
      command: "bash e2e/start-bridge.sh",
      cwd: root,
      url: "http://127.0.0.1:8657/api/healthz",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @sa/web dev",
      cwd: root,
      url: "http://127.0.0.1:5183",
      reuseExistingServer: false,
      env: {
        SA_WEB_PORT: "5183",
        SA_BRIDGE_URL: "http://127.0.0.1:8657",
        SA_RELAY_URL: "http://127.0.0.1:8658",
      },
    },
  ],
});
