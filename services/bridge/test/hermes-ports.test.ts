import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermesRuntime } from "../src/agents/hermes.js";
import { type Db, openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";

let db: Db;
beforeEach(async () => {
  db = await openDb("pglite://memory");
  await migrate(db);
  await db.query("insert into sa.users (id, display_name, pin_hash) values ('ana','Ana','x')");
});
afterEach(() => db.close());

describe("hermes port allocation", () => {
  it("gives concurrently pre-warmed agents distinct ports within 8701-8709", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `agent-${i}-00000000`);
    for (const id of ids) {
      await db.query(
        "insert into sa.agents (id, owner_user_id, name, template) values ($1,'ana',$1,'qa')",
        [id],
      );
    }
    const rt = new HermesRuntime({ db }) as unknown as {
      allocatePort(id: string): Promise<number>;
    };
    const ports = await Promise.all(ids.map((id) => rt.allocatePort(id)));
    expect(new Set(ports).size).toBe(ids.length);
    for (const p of ports) expect(p).toBeGreaterThanOrEqual(8701);
    for (const p of ports) expect(p).toBeLessThanOrEqual(8709);
  });
});

describe("hermes gateway start", () => {
  it("starts gateways one at a time, and one failing start does not block the next", async () => {
    const rt = new HermesRuntime({ db }) as unknown as {
      start(a: { id: string }): Promise<void>;
      ensureStarted(a: { id: string }): Promise<void>;
    };
    let active = 0;
    let peak = 0;
    rt.start = async (a) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      if (a.id === "a1") throw new Error("boom");
    };
    const results = await Promise.allSettled(
      ["a0", "a1", "a2"].map((id) => rt.ensureStarted({ id })),
    );
    expect(peak).toBe(1);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});

describe("hermes stale gateways", () => {
  it("reapStale stops a gateway left by a dead bridge, with its children, and removes the pid file", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sa-fake-hermes-"));
    const pidDir = join(tmp, "pids");
    mkdirSync(pidDir, { recursive: true });
    process.env.SA_AGENT_PID_DIR = pidDir;
    const childPidFile = join(tmp, "child.pid");
    writeFileSync(join(tmp, "hermes"), `#!/bin/sh\nsleep 60 &\necho $! > ${childPidFile}\nwait\n`, {
      mode: 0o755,
    });
    const gw = spawn(join(tmp, "hermes"), ["-p", "sa_agent_reaptest0", "gateway"], {
      detached: true,
      stdio: "ignore",
    });
    const exited = new Promise<string | null>((r) => gw.on("exit", (_c, sig) => r(sig)));
    const pidFile = join(pidDir, "sa_agent_reaptest0.pid");
    writeFileSync(pidFile, `${gw.pid} 8709\n`, { mode: 0o600 });
    await expect.poll(() => existsSync(childPidFile), { timeout: 3000 }).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    const childPid = Number(readFileSync(childPidFile, "utf8").trim());

    try {
      await (new HermesRuntime({ db }) as unknown as { reapStale(): Promise<void> }).reapStale();
      expect(await exited).toBe("SIGTERM");
      expect(existsSync(pidFile)).toBe(false);
      await expect
        .poll(
          () => {
            try {
              process.kill(childPid, 0);
              return "alive";
            } catch {
              return "dead";
            }
          },
          { timeout: 3000 },
        )
        .toBe("dead");
    } finally {
      delete process.env.SA_AGENT_PID_DIR;
      rmSync(pidFile, { force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
