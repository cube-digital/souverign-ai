import { join } from "node:path";
import { createRelay } from "./server.js";

const adminToken = process.env.RELAY_ADMIN_TOKEN;
if (!adminToken) {
  console.error(JSON.stringify({ level: "error", msg: "RELAY_ADMIN_TOKEN is required" }));
  process.exit(1);
}
const repoRoot = join(import.meta.dirname, "..", "..", "..");
await createRelay({
  dbPath: process.env.RELAY_DB ?? join(repoRoot, ".run", "relay.sqlite"),
  adminToken,
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8648),
});
