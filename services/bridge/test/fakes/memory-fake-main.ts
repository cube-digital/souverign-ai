import { startFakeMemoryServer } from "./memory-fake.js";

const token = process.env.MEMORY_TOKEN;
if (!token) {
  console.error("MEMORY_TOKEN is required");
  process.exit(1);
}
const port = Number(process.env.MEMORY_PORT ?? 8656);
await startFakeMemoryServer({ port, token });
console.log(`fake memory listening on 127.0.0.1:${port}`);
