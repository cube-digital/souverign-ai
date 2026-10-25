/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const bridge = process.env.SA_BRIDGE_URL || "http://127.0.0.1:8647";
const relay = process.env.SA_RELAY_URL || "http://127.0.0.1:8648";
const port = Number(process.env.SA_WEB_PORT || 5173);
const proxy = { "/api": bridge, "/relay": { target: relay, ws: true } };
const allowedHosts = [".ts.net"]; // tailscale serve forwards with the tailnet host name

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: "127.0.0.1", port, strictPort: true, proxy, allowedHosts },
  preview: { host: "127.0.0.1", port, strictPort: true, proxy, allowedHosts },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
    passWithNoTests: true,
  },
});
