import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { migrate } from "./migrate.js";
import { httpRelayAdmin } from "./relay-admin.js";

const relayAdmin = httpRelayAdmin();
const db = await openDb();
await migrate(db);
const app = buildApp({ db, relayAdmin });
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8647);
await app.listen({ host, port });
console.log(JSON.stringify({ level: "info", msg: "bridge listening", host, port }));
