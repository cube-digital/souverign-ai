import { EchoRuntime } from "./agents/echo.js";
import { HermesRuntime } from "./agents/hermes.js";
import { AgentHost } from "./agents/host.js";
import type { AgentRuntime } from "./agents/runtime.js";
import { requireMasterKey } from "./agents/secrets.js";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { ToolLog } from "./mcp/tool-log.js";
import { migrate } from "./migrate.js";
import { httpRelayAdmin } from "./relay-admin.js";

requireMasterKey();
const relayAdmin = httpRelayAdmin();
const db = await openDb();
await migrate(db);
const runtime: AgentRuntime =
  process.env.AGENT_RUNTIME === "echo" ? new EchoRuntime() : new HermesRuntime({ db });
const adminToken = process.env.RELAY_ADMIN_TOKEN;
if (!adminToken) throw new Error("RELAY_ADMIN_TOKEN is required");
const toolLog = new ToolLog();
const agentHost = new AgentHost({
  db,
  runtime,
  relayInternalUrl: process.env.RELAY_INTERNAL_URL || "http://127.0.0.1:8648",
  adminToken,
  toolLog,
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void agentHost.stopAll().finally(() => process.exit(0));
  });
}
const app = buildApp({
  db,
  relayAdmin,
  agentHost,
  toolLog,
  rtSimUrl: process.env.RT_SIM_URL || "http://127.0.0.1:8649",
});
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8647);
await app.listen({ host, port });
void agentHost
  .start()
  .catch((e) =>
    console.error(
      JSON.stringify({ level: "error", msg: "agent host start failed", error: String(e) }),
    ),
  );
console.log(JSON.stringify({ level: "info", msg: "bridge listening", host, port }));
