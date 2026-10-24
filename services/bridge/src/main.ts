import { TICKET_TTL_MS } from "@sa/protocol";
import { signTicket } from "@sa/protocol/ticket";
import { EchoRuntime } from "./agents/echo.js";
import { HermesRuntime } from "./agents/hermes.js";
import { AgentHost } from "./agents/host.js";
import type { AgentRuntime } from "./agents/runtime.js";
import { requireMasterKey } from "./agents/secrets.js";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { ToolLog } from "./mcp/tool-log.js";
import { migrate } from "./migrate.js";
import type { PluginContext } from "./plugin-api.js";
import { loadPlugins, mergeHooks } from "./plugin-loader.js";
import { httpRelayAdmin } from "./relay-admin.js";
import { windowGuard } from "./workspace/custodian.js";

const logLine = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, ...extra }));

requireMasterKey();
const rawRelayAdmin = httpRelayAdmin();
const db = await openDb();
// D-12: every relay add with a history window goes through the guard, once, for all callers.
const relayAdmin = windowGuard(db, rawRelayAdmin);
await migrate(db);
await db.query("update sa.agents set api_port = null"); // no gateway survives a restart
const runtime: AgentRuntime =
  process.env.AGENT_RUNTIME === "echo" ? new EchoRuntime() : new HermesRuntime({ db });
await runtime.reapStale?.();
const adminToken = process.env.RELAY_ADMIN_TOKEN;
if (!adminToken) throw new Error("RELAY_ADMIN_TOKEN is required");
const toolLog = new ToolLog();
const relayInternalUrl = process.env.RELAY_INTERNAL_URL || "http://127.0.0.1:8648";
const opsSimUrl = process.env.OPS_SIM_URL || "http://127.0.0.1:8649";
const agentHost = new AgentHost({ db, runtime, relayInternalUrl, adminToken, toolLog });
const plugins = process.env.SA_PLUGINS === "0" ? [] : await loadPlugins();
const ctx: PluginContext = {
  db,
  relayAdmin,
  relayInternalUrl,
  ticketFor: async (deviceId) => {
    // Only the bridge's own devices (agents and seeded people), never a user's device.
    const own = await db.query(
      `select 1 from sa.agent_devices where device_id = $1
       union all select 1 from sa.seed_devices where device_id = $1`,
      [deviceId],
    );
    if (own.length === 0) throw new Error("not a bridge device");
    return signTicket(adminToken, deviceId, TICKET_TTL_MS).ticket;
  },
  opsSimUrl,
  agentHost,
  log: (msg, extra) => logLine("info", msg, extra),
};
for (const p of plugins) {
  try {
    await p.init?.(ctx);
  } catch (e) {
    logLine("error", "plugin init failed", { plugin: p.name, error: (e as Error).message });
  }
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    void (async () => {
      for (const p of plugins) {
        try {
          await p.stop?.();
        } catch (e) {
          logLine("error", "plugin stop failed", { plugin: p.name, error: (e as Error).message });
        }
      }
      await agentHost.stopAll().catch(() => {});
      process.exit(0);
    })();
  });
}
const app = buildApp({
  db,
  relayAdmin,
  agentHost,
  toolLog,
  opsSimUrl,
  plugins,
  hooks: mergeHooks(plugins),
});
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8647);
await app.listen({ host, port });
void agentHost
  .start()
  .catch((e) => logLine("error", "agent host start failed", { error: String(e) }));
for (const p of plugins) {
  try {
    p.start?.(ctx);
  } catch (e) {
    logLine("error", "plugin start failed", { plugin: p.name, error: (e as Error).message });
  }
}
logLine("info", "bridge listening", { host, port });
