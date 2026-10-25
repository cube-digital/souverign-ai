import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../db.js";
import type { Log } from "../plugin-api.js";
import { livekitAvailable as defaultAvailable } from "./livekit-health.js";
import { CallError, failNotetaker } from "./store.js";

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

import { notetakerToken } from "./tokens.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const KILL_AFTER_MS = 5000;

export type SpawnedWorker = {
  pid: number;
  onExit(cb: (code: number | null) => void): void;
  kill(signal?: string): void;
};
export interface Spawner {
  spawn(
    cmd: string,
    args: string[],
    opts: { env: Record<string, string>; stdin: string },
  ): SpawnedWorker;
}

/** Spawns a child with the given env, writes `stdin` once and closes it. */
export const nodeSpawner: Spawner = {
  spawn(cmd, args, opts) {
    const child = nodeSpawn(cmd, args, {
      env: opts.env,
      cwd: repoRoot,
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin);
    return {
      pid: child.pid ?? 0,
      onExit: (cb) => {
        child.on("exit", (code) => cb(code));
        child.on("error", () => cb(1));
      },
      kill: (sig) => {
        const signal = (sig ?? "SIGTERM") as NodeJS.Signals;
        try {
          // The worker runs in its own process group: uv and its python child go together.
          process.kill(-(child.pid ?? 0), signal);
        } catch {
          child.kill(signal);
        }
      },
    };
  },
};

export type NotetakersOpts = {
  db: Db;
  spawner: Spawner;
  livekitAvailable?: () => Promise<boolean>;
  log: Log;
  /** The notetaker failed while active; the final summary must run. */
  onFinal: (notetakerId: string) => void | Promise<void>;
  pidDir?: string;
  env?: Record<string, string | undefined>;
};

export class Notetakers {
  private readonly running = new Map<string, SpawnedWorker>();
  private readonly pidDir: string;
  private readonly env: Record<string, string | undefined>;
  private readonly available: () => Promise<boolean>;

  constructor(private readonly o: NotetakersOpts) {
    this.pidDir = o.pidDir ?? join(repoRoot, ".run", "notetakers");
    this.env = o.env ?? process.env;
    this.available = o.livekitAvailable ?? defaultAvailable;
  }

  /** Starts the notetaker's worker per `SA_NOTETAKER` (worker | fake | off). */
  async start(callId: string, notetakerId: string, mediaKey?: string): Promise<void> {
    const { db, log } = this.o;
    if (!SAFE_ID.test(callId) || !SAFE_ID.test(notetakerId))
      throw new CallError(400, "invalid_request");
    const mode = this.env.SA_NOTETAKER ?? "worker";
    if (mode === "off") throw new CallError(503, "notetaker_disabled");
    if (mode === "fake") {
      await db.query("update sa.call_notetakers set worker = 'fake' where id = $1", [notetakerId]);
      return;
    }
    if (!(await this.available())) throw new CallError(503, "livekit_unavailable");
    const [nt] = await db.query<{ agent_id: string; invited_by_name: string }>(
      `select n.agent_id, u.display_name as invited_by_name
         from sa.call_notetakers n join sa.users u on u.id = n.invited_by where n.id = $1`,
      [notetakerId],
    );
    if (!nt) throw new CallError(404, "not_found");
    if (!(this.env.LIVEKIT_API_SECRET ?? process.env.LIVEKIT_API_SECRET)) {
      throw new CallError(503, "livekit_unavailable");
    }
    const lkToken = await notetakerToken({
      callId,
      agentId: nt.agent_id,
      invitedByName: nt.invited_by_name,
      ...(this.env.LIVEKIT_API_SECRET ? { secret: this.env.LIVEKIT_API_SECRET } : {}),
    });
    const port = process.env.PORT || "8647";
    const env: Record<string, string> = {
      SA_BRIDGE_URL: this.env.SA_BRIDGE_URL ?? `http://127.0.0.1:${port}`,
      SA_NOTETAKER_ID: notetakerId,
      LIVEKIT_URL: this.env.LIVEKIT_URL ?? "ws://127.0.0.1:7880",
      AUDIO_URL: this.env.AUDIO_URL ?? "http://127.0.0.1:8645",
      SA_STT_LANGUAGE: this.env.SA_STT_LANGUAGE ?? "en",
    };
    for (const k of ["PATH", "HOME", "LANG"]) {
      const v = process.env[k];
      if (v) env[k] = v;
    }
    // Secrets travel as one JSON line on stdin: never argv or env.
    const stdin = `${JSON.stringify({
      lk_token: lkToken,
      meeting_token: this.env.MEETING_TOKEN ?? "",
      audio_token: this.env.AUDIO_TOKEN ?? "",
      media_key: mediaKey ?? null,
    })}\n`;
    const worker = this.o.spawner.spawn(
      "uv",
      ["run", "--project", repoRoot, "--no-sync", "sa-meeting", "join"],
      { env, stdin },
    );
    this.running.set(notetakerId, worker);
    mkdirSync(this.pidDir, { recursive: true });
    writeFileSync(join(this.pidDir, `${notetakerId}.pid`), `${worker.pid}\n`);
    worker.onExit((code) => {
      void this.exited(notetakerId, code).catch((e) =>
        log("notetaker exit handling failed", {
          notetaker: notetakerId,
          error: (e as Error).name,
        }),
      );
    });
    log("notetaker worker started", { call: callId, notetaker: notetakerId, pid: worker.pid });
  }

  private async exited(notetakerId: string, code: number | null): Promise<void> {
    const known = this.running.delete(notetakerId);
    rmSync(join(this.pidDir, `${notetakerId}.pid`), { force: true });
    // Not tracked any more: the bridge itself shut this worker down, which is not a failure.
    if (!known || code === 0) return;
    // Only a crash while active fails the notetaker; a stop or end already moved it on.
    if (await failNotetaker(this.o.db, notetakerId)) {
      this.o.log("notetaker worker failed", { notetaker: notetakerId, code });
      await this.o.onFinal(notetakerId);
    }
  }

  /** SIGTERM, then SIGKILL after 5 s. */
  stopProcess(notetakerId: string): void {
    const w = this.running.get(notetakerId);
    if (!w) return;
    w.kill("SIGTERM");
    const t = setTimeout(() => {
      if (this.running.get(notetakerId) === w) w.kill("SIGKILL");
    }, KILL_AFTER_MS);
    t.unref?.();
  }

  /** Bridge shutdown: no worker outlives it. */
  killAll(): void {
    const all = [...this.running];
    this.running.clear();
    for (const [id, w] of all) {
      w.kill("SIGTERM");
      rmSync(join(this.pidDir, `${id}.pid`), { force: true });
    }
  }

  /** Kills workers left over from a previous bridge process (pid files). */
  cleanupOrphans(): void {
    let files: string[];
    try {
      files = readdirSync(this.pidDir).filter((f) => f.endsWith(".pid"));
    } catch {
      return;
    }
    for (const f of files) {
      const path = join(this.pidDir, f);
      try {
        const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
        // A reused pid must not take an unrelated process down.
        if (pid > 1 && isWorker(pid)) {
          try {
            process.kill(-pid, "SIGTERM");
          } catch {
            process.kill(pid, "SIGTERM");
          }
        }
      } catch {
        // already gone
      }
      rmSync(path, { force: true });
    }
  }
}

function isWorker(pid: number): boolean {
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    // The full command line of our spawn, not just a substring.
    return cmd.includes(`--project ${repoRoot} --no-sync sa-meeting join`);
  } catch {
    return false;
  }
}
