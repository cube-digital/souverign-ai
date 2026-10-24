/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const bridge = process.env.SA_BRIDGE_URL || "http://127.0.0.1:8647";
const relay = process.env.SA_RELAY_URL || "http://127.0.0.1:8648";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.SA_WEB_PORT || 5173),
    strictPort: true,
    proxy: {
      "/api": bridge,
      "/relay": { target: relay, ws: true },
    },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    passWithNoTests: true,
  },
});
