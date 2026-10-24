import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import type { Db } from "../db.js";
import {
  type AgentRuntime,
  abortError,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type RuntimeAgent,
  splitThink,
  visibleStream,
} from "./runtime.js";
import { hermesApiKey, mcpToken } from "./secrets.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PORTS = [8701, 8702, 8703, 8704, 8705, 8706, 8707, 8708, 8709];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const profileName = (agentId: string): string => `sa_agent_${agentId.slice(0, 12)}`;

type ModelsConfig = {
  llm: {
    host: string;
    port: number;
    profiles: Record<string, { repo: string }>;
    active_profile: string;
  };
};

// One Hermes session per turn: Hermes keeps server-side history per session and applies only the
// first turn's system prompt, which would hide newer chat context (new messages, image
// descriptions). The bridge sends the compact context itself on every turn.
function turnSession(agentId: string, chatId: string): string {
  return `${agentId}:${chatId}:${Date.now().toString(36)}`;
}

const TURN_TIMEOUT_MS = 180_000;

/** The turn's signal combined with the 180 s limit, and a mapper that turns whatever the aborted
 * fetch threw into `AbortError` (Stop) or `TimeoutError` (limit). */
function turnSignal(opts?: ChatOptions): {
  signal: AbortSignal;
  normalize: (e: unknown) => unknown;
} {
  const timeout = AbortSignal.timeout(TURN_TIMEOUT_MS);
  const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const normalize = (e: unknown) => {
    if (opts?.signal?.aborted) return abortError();
    if (timeout.aborted)
      return Object.assign(new Error("model time limit"), { name: "TimeoutError" });
    return e;
  };
  return { signal, normalize };
}

const isAbortOrTimeout = (e: unknown) =>
  (e as Error)?.name === "AbortError" || (e as Error)?.name === "TimeoutError";

export function llmTarget(): { baseUrl: string; model: string } {
  const cfg = parse(readFileSync(join(ROOT, "config", "models.yaml"), "utf8")) as ModelsConfig;
  const profile = process.env.LLM_PROFILE || cfg.llm.active_profile;
  const repo = cfg.llm.profiles[profile]?.repo;
  if (!repo) throw new Error(`unknown LLM profile: ${profile}`);
  return { baseUrl: `http://${cfg.llm.host}:${cfg.llm.port}/v1`, model: repo };
}

/** config.yaml for one agent's Hermes profile. */
export function renderHermesConfig(a: { agentId: string; port: number }): string {
  const { model } = llmTarget();
  const bridgePort = process.env.PORT || 8647;
  // Gateways talk to the bridge's loopback proxy, which forces the first tool round (bug 4).
  const proxyUrl = `http://127.0.0.1:${bridgePort}/llm/${a.agentId}/v1`;
  const tpl = readFileSync(join(ROOT, "infra", "hermes", "config.template.yaml"), "utf8")
    .replace("${LLM_BASE_URL}", proxyUrl)
    .replace("${LLM_MODEL}", model)
    .replace("${API_PORT}", String(a.port))
    .replace("${API_KEY}", hermesApiKey(a.agentId));
  const cfg = parse(tpl) as Record<string, any>;
  const toolsets = parse(readFileSync(join(ROOT, "infra", "hermes", "toolsets.yaml"), "utf8")) as {
    disable: string[];
  };
  cfg.agent.disabled_toolsets = toolsets.disable;
  cfg.mcp_servers = {
    bridge: {
      url: `http://127.0.0.1:${bridgePort}/mcp`,
      headers: { Authorization: `Bearer ${mcpToken(a.agentId)}` },
    },
  };
  return stringify(cfg);
}

function renderSoul(agent: RuntimeAgent): string {
  const tpl = readFileSync(join(ROOT, "infra", "hermes", "SOUL.template.md"), "utf8");
  const templateText = readFileSync(
    join(ROOT, "infra", "hermes", "templates", `${agent.template}.md`),
    "utf8",
  ).trim();
  const soul = [templateText, agent.soul.trim()].filter(Boolean).join("\n\n");
  // One pass with function replacers: names containing `$&`, `$'` or `${...}` cannot inject text.
  const values: Record<string, string> = {
    AGENT_NAME: agent.name,
    OWNER_NAME: agent.ownerName,
    SOUL: soul,
  };
  return tpl.replace(/\$\{(AGENT_NAME|OWNER_NAME|SOUL)\}/g, (_m, key: string) => values[key] ?? "");
}

const PID_DIR = join(ROOT, ".run", "agents");
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const commandOf = (pid: number): string => {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  } catch {
    return "";
  }
};
const signalGroup = (pid: number, sig: NodeJS.Signals): void => {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {}
  }
};

/** Stops the Hermes gateway a pid file points at (if it is still one), then deletes the file. */
async function reapPidFile(file: string): Promise<void> {
  let pid = Number.NaN;
  try {
    pid = Number(readFileSync(file, "utf8").trim().split(/\s+/)[0]);
  } catch {}
  if (
    Number.isInteger(pid) &&
    pid > 1 &&
    isAlive(pid) &&
    commandOf(pid).includes("hermes -p sa_agent_")
  ) {
    signalGroup(pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    while (isAlive(pid) && Date.now() < deadline) await sleep(100);
    if (isAlive(pid)) signalGroup(pid, "SIGKILL");
    console.log(JSON.stringify({ level: "info", msg: "stale gateway stopped", pid }));
  }
  rmSync(file, { force: true });
}

function pidFiles(): { file: string; profile: string; port: number }[] {
  let names: string[] = [];
  try {
    names = readdirSync(PID_DIR).filter((f) => f.endsWith(".pid"));
  } catch {}
  return names.map((n) => {
    const file = join(PID_DIR, n);
    let port = Number.NaN;
    try {
      port = Number(readFileSync(file, "utf8").trim().split(/\s+/)[1]);
    } catch {}
    return { file, profile: n.slice(0, -4), port };
  });
}

type Gateway = { child: ChildProcess; port: number };
export type AgentStatus = "starting" | "running" | "error" | "stopped";

export class HermesRuntime implements AgentRuntime {
  private gateways = new Map<string, Gateway>();
  private starting = new Map<string, Promise<void>>();
  readonly status = new Map<string, { status: AgentStatus; lastLog?: string }>();

  constructor(private deps: { db: Db }) {}

  private bin = (): string => process.env.HERMES_BIN ?? "hermes";

  private portLock: Promise<unknown> = Promise.resolve();

  /** Serialized so concurrent pre-warms cannot pick the same port. */
  private allocatePort(agentId: string): Promise<number> {
    const run = this.portLock.then(() => this.pickPort(agentId));
    this.portLock = run.catch(() => undefined);
    return run;
  }

  private async pickPort(agentId: string): Promise<number> {
    const rows = await this.deps.db.query<{ id: string; api_port: number | null }>(
      "select id, api_port from sa.agents where api_port is not null",
    );
    const own = rows.find((r) => r.id === agentId);
    if (own?.api_port) return own.api_port;
    const used = new Set([
      ...[...this.gateways.values()].map((g) => g.port),
      ...rows.map((r) => r.api_port),
    ]);
    const port = PORTS.find((p) => !used.has(p));
    if (!port) throw new Error("no free agent port");
    await this.deps.db.query("update sa.agents set api_port = $1 where id = $2", [port, agentId]);
    return port;
  }

  private releasePort(agentId: string): void {
    void this.deps.db.query("update sa.agents set api_port = null where id = $1", [agentId]);
  }

  private setStatus(agent: RuntimeAgent, status: AgentStatus, lastLog?: string): void {
    this.status.set(agent.id, { status, ...(lastLog ? { lastLog } : {}) });
    void this.deps.db.query("update sa.agents set status = $1 where id = $2", [status, agent.id]);
  }

  ensureStarted(agent: RuntimeAgent): Promise<void> {
    const running = this.starting.get(agent.id);
    if (running) return running;
    const p = this.start(agent).finally(() => this.starting.delete(agent.id));
    this.starting.set(agent.id, p);
    return p;
  }

  private async start(agent: RuntimeAgent): Promise<void> {
    if (this.gateways.has(agent.id) && this.status.get(agent.id)?.status === "running") return;
    this.setStatus(agent, "starting");
    try {
      const name = profileName(agent.id);
      const port = await this.allocatePort(agent.id);
      const dir = join(homedir(), ".hermes", "profiles", name);
      if (!existsSync(dir)) await this.run(["profile", "create", name]);
      writeFileSync(join(dir, "config.yaml"), renderHermesConfig({ agentId: agent.id, port }));
      writeFileSync(join(dir, "SOUL.md"), renderSoul(agent));
      writeFileSync(
        join(dir, ".env"),
        `API_SERVER_ENABLED=true\nAPI_SERVER_HOST=127.0.0.1\nAPI_SERVER_PORT=${port}\nAPI_SERVER_KEY=${hermesApiKey(agent.id)}\n`,
      );
      for (const f of ["config.yaml", "SOUL.md", ".env"]) chmodSync(join(dir, f), 0o600);

      const logDir = PID_DIR;
      mkdirSync(logDir, { recursive: true });
      const logFile = join(logDir, `${name}.log`);
      const pidFile = join(logDir, `${name}.pid`);
      // A gateway left by a dead bridge may hold this profile or this port.
      for (const f of pidFiles())
        if (f.profile === name || f.port === port) await reapPidFile(f.file);
      // Host-gateway rescan (as in up.sh): the gateway may exit at once; retry.
      let child: ChildProcess | undefined;
      for (let attempt = 1; attempt <= 5; attempt++) {
        const fd = openSync(logFile, "a");
        child = spawn(this.bin(), ["-p", name, "gateway", "run"], {
          stdio: ["ignore", fd, fd],
          detached: true,
        });
        closeSync(fd);
        const exitedAtOnce = await Promise.race([
          new Promise<boolean>((r) => child?.once("exit", () => r(true))),
          sleep(3000).then(() => false),
        ]);
        if (!exitedAtOnce) break;
        child = undefined;
        if (attempt < 5) await sleep(10_000);
      }
      if (!child) throw new Error(lastLine(logFile) || "gateway exited at once");
      this.gateways.set(agent.id, { child, port });
      writeFileSync(pidFile, `${child.pid} ${port}\n`, { mode: 0o600 });
      child.once("exit", () => {
        rmSync(pidFile, { force: true });
        this.gateways.delete(agent.id);
        this.releasePort(agent.id);
        if (this.status.get(agent.id)?.status !== "stopped") {
          this.setStatus(agent, "error", lastLine(logFile));
        }
      });
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (!this.gateways.has(agent.id)) throw new Error(lastLine(logFile) || "gateway exited");
        if (await this.healthy(port)) {
          this.setStatus(agent, "running");
          console.log(
            JSON.stringify({ level: "info", msg: "agent running", agent: agent.id, port }),
          );
          return;
        }
        await sleep(1000);
      }
      throw new Error(lastLine(logFile) || "health timeout");
    } catch (e) {
      this.setStatus(agent, "error", (e as Error).message);
      throw e;
    }
  }

  private run(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const c = spawn(this.bin(), args, { stdio: "ignore" });
      c.once("error", reject);
      c.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`hermes ${args[0]} exited ${code}`)),
      );
    });
  }

  private async healthy(port: number): Promise<boolean> {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {
      return false;
    }
  }

  /**
   * Reasoning source, verified against a live gateway (Hermes v0.22.5, Qwen3.5-9B): the
   * non-streaming chat completion carries the turn's reasoning in `message.reasoning_content`
   * (the gateway derives it from the assistant messages it persisted; `message.reasoning` is
   * absent). The Responses API reasoning items and Runs API events carry the same text only in
   * streaming form, so they are not needed here. `<think>` blocks in the content are still split
   * out as a fallback.
   */
  async chat(
    agent: RuntimeAgent,
    chatId: string,
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): Promise<ChatResult> {
    const g = this.gateways.get(agent.id);
    const port = g?.port ?? (await this.allocatePort(agent.id));
    const { signal, normalize } = turnSignal(opts);
    let data: {
      choices?: {
        message?: { content?: string; reasoning_content?: string; reasoning?: string };
      }[];
    };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${hermesApiKey(agent.id)}`,
          "x-hermes-session-id": turnSession(agent.id, chatId),
        },
        body: JSON.stringify({ model: "hermes-agent", messages }),
        signal,
      });
      if (!res.ok) throw new Error(`hermes chat failed: ${res.status}`);
      data = (await res.json()) as typeof data;
    } catch (e) {
      throw normalize(e);
    }
    const msg = data.choices?.[0]?.message ?? {};
    const split = splitThink(msg.content ?? "");
    const field = (msg.reasoning_content ?? msg.reasoning ?? "").trim();
    const reasoning = [field, split.reasoning].filter(Boolean).join("\n\n");
    return reasoning ? { content: split.content, reasoning } : { content: split.content };
  }

  /**
   * Streaming chat: SSE `data:` lines from `/v1/chat/completions` with `stream: true`. Content
   * deltas go to `onDelta`; reasoning deltas are only collected. If the stream fails before the
   * first delta, the non-streaming `chat` runs once instead, except after Stop or the time limit:
   * closing the SSE stream is what makes Hermes interrupt its agent, so an aborted stream never
   * starts an uninterruptible non-streaming run.
   */
  async chatStream(
    agent: RuntimeAgent,
    chatId: string,
    messages: ChatMessage[],
    onDelta: (text: string) => void,
    opts?: ChatOptions,
  ): Promise<ChatResult> {
    let gotDelta = false;
    const { signal, normalize } = turnSignal(opts);
    try {
      const g = this.gateways.get(agent.id);
      const port = g?.port ?? (await this.allocatePort(agent.id));
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${hermesApiKey(agent.id)}`,
          "x-hermes-session-id": turnSession(agent.id, chatId),
        },
        body: JSON.stringify({ model: "hermes-agent", messages, stream: true }),
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`hermes stream failed: ${res.status}`);
      let content = "";
      let reasoning = "";
      let shown = 0;
      let buf = "";
      let done = false;
      const handle = (line: string) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          done = true;
          return;
        }
        let delta: { content?: string; reasoning_content?: string; reasoning?: string } | undefined;
        try {
          delta = JSON.parse(data)?.choices?.[0]?.delta;
        } catch {
          return;
        }
        const r = delta?.reasoning_content ?? delta?.reasoning;
        if (r) reasoning += r;
        if (delta?.content) {
          gotDelta = true;
          content += delta.content;
          const visible = visibleStream(content);
          if (visible.length > shown) {
            onDelta(visible.slice(shown));
            shown = visible.length;
          }
        }
      };
      const decoder = new TextDecoder();
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) handle(l.trim());
        if (done) break;
      }
      if (buf.trim()) handle(buf.trim());
      const split = splitThink(content);
      const all = [reasoning.trim(), split.reasoning].filter(Boolean).join("\n\n");
      return all ? { content: split.content, reasoning: all } : { content: split.content };
    } catch (raw) {
      const e = normalize(raw);
      if (gotDelta || isAbortOrTimeout(e)) throw e;
      return this.chat(agent, chatId, messages, opts);
    }
  }

  modelName(): string {
    try {
      return llmTarget().model.split("/").pop() || "local";
    } catch {
      return "local";
    }
  }

  /** Stops gateways left behind by a bridge that died without cleaning up. */
  async reapStale(): Promise<void> {
    for (const f of pidFiles()) await reapPidFile(f.file);
  }

  async stop(agent: RuntimeAgent): Promise<void> {
    const g = this.gateways.get(agent.id);
    this.status.set(agent.id, { status: "stopped" });
    if (!g) return;
    this.gateways.delete(agent.id);
    this.releasePort(agent.id);
    rmSync(join(PID_DIR, `${profileName(agent.id)}.pid`), { force: true });
    try {
      process.kill(-(g.child.pid ?? 0), "SIGTERM");
    } catch {
      g.child.kill("SIGTERM");
    }
    this.setStatus(agent, "stopped");
  }

  async stopAll(): Promise<void> {
    for (const [id, g] of this.gateways) {
      this.status.set(id, { status: "stopped" });
      rmSync(join(PID_DIR, `${profileName(id)}.pid`), { force: true });
      try {
        process.kill(-(g.child.pid ?? 0), "SIGTERM");
      } catch {
        g.child.kill("SIGTERM");
      }
    }
    this.gateways.clear();
    await this.deps.db.query("update sa.agents set api_port = null");
  }
}

function lastLine(file: string): string {
  try {
    return readFileSync(file, "utf8").trim().split("\n").at(-1) ?? "";
  } catch {
    return "";
  }
}
