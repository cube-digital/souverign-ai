import { createSim } from "./server.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8649);
const sim = await createSim({ host, port });
console.log(JSON.stringify({ level: "info", msg: "ops-sim listening", url: sim.url }));
