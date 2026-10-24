import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { waitForRelay } from "../src/relay-ready.js";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
  }
});

describe("waitForRelay", () => {
  it("the bridge waits for the relay to answer before connecting", async () => {
    server = createServer((req, res) => {
      res.statusCode = req.url === "/relay/healthz" ? 200 : 404;
      res.end("ok");
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    expect(
      await waitForRelay(`http://127.0.0.1:${port}`, { timeoutMs: 2000, intervalMs: 50 }),
    ).toBe(true);
    expect(await waitForRelay("http://127.0.0.1:1", { timeoutMs: 200, intervalMs: 50 })).toBe(
      false,
    );
  });
});
