import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nodeSpawner } from "../src/calls/notetaker.js";

it("a spawned worker's stderr lands in its log file, and stdin still reaches it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sa-worker-log-"));
  try {
    const logFile = join(dir, "nt1.log");
    const w = nodeSpawner.spawn(
      process.execPath,
      ["-e", "process.stdin.once('data', d => { console.error('got ' + d.length); });"],
      { env: {}, stdin: "hello\n", logFile },
    );
    const code = await new Promise<number | null>((resolve) => w.onExit(resolve));
    expect(code).toBe(0);
    expect(readFileSync(logFile, "utf8").trim()).toBe("got 6");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
