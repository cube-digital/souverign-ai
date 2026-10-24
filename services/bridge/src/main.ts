import { EchoRuntime } from "./agents/echo.js";
import { HermesRuntime } from "./agents/hermes.js";
import type { AgentRuntime } from "./agents/runtime.js";
import { requireMasterKey } from "./agents/secrets.js";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { migrate } from "./migrate.js";
import { httpRelayAdmin } from "./relay-admin.js";

requireMasterKey();
const relayAdmin = httpRelayAdmin();
const db = await openDb();
await migrate(db);
const runtime: AgentRuntime =
  process.env.AGENT_RUNTIME === "echo" ? new EchoRuntime() : new HermesRuntime({ db });
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void runtime.stopAll().finally(() => process.exit(0));
  });
}
const app = buildApp({ db, relayAdmin });
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8647);
await app.listen({ host, port });
console.log(JSON.stringify({ level: "info", msg: "bridge listening", host, port }));
