import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import type { Db } from "../db.js";
import {
  type AgentRuntime,
  type ChatMessage,
  type ChatResult,
  type RuntimeAgent,
  splitThink,
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

function llmTarget(): { baseUrl: string; model: string } {
  const cfg = parse(readFileSync(join(ROOT, "config", "models.yaml"), "utf8")) as ModelsConfig;
  const profile = process.env.LLM_PROFILE || cfg.llm.active_profile;
  const repo = cfg.llm.profiles[profile]?.repo;
  if (!repo) throw new Error(`unknown LLM profile: ${profile}`);
  return { baseUrl: `http://${cfg.llm.host}:${cfg.llm.port}/v1`, model: repo };
}

/** config.yaml for one agent's Hermes profile. */
export function renderHermesConfig(a: { agentId: string; port: number }): string {
  const { baseUrl, model } = llmTarget();
  const tpl = readFileSync(join(ROOT, "infra", "hermes", "config.template.yaml"), "utf8")
    .replace("${LLM_BASE_URL}", baseUrl)
    .replace("${LLM_MODEL}", model)
    .replace("${API_PORT}", String(a.port))
    .replace("${API_KEY}", hermesApiKey(a.agentId));
  const cfg = parse(tpl) as Record<string, any>;
  const toolsets = parse(readFileSync(join(ROOT, "infra", "hermes", "toolsets.yaml"), "utf8")) as {
    disable: string[];
  };
  cfg.agent.disabled_toolsets = toolsets.disable;
  const bridgePort = process.env.PORT || 8647;
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
  return tpl
    .replaceAll("${AGENT_NAME}", agent.name)
    .replaceAll("${OWNER_NAME}", agent.ownerName)
    .replace("${SOUL}", () => soul);
}

type Gateway = { child: ChildProcess; port: number };
export type AgentStatus = "starting" | "running" | "error" | "stopped";

export class HermesRuntime implements AgentRuntime {
  private gateways = new Map<string, Gateway>();
  private starting = new Map<string, Promise<void>>();
  readonly status = new Map<string, { status: AgentStatus; lastLog?: string }>();

  constructor(private deps: { db: Db }) {}

  private bin = (): string => process.env.HERMES_BIN ?? "hermes";

  private async allocatePort(agentId: string): Promise<number> {
    const [own] = await this.deps.db.query<{ api_port: number | null }>(
      "select api_port from sa.agents where id = $1",
      [agentId],
    );
    if (own?.api_port) return own.api_port;
    const used = new Set(
      (
        await this.deps.db.query<{ api_port: number }>(
          "select api_port from sa.agents where api_port is not null",
        )
      ).map((r) => r.api_port),
    );
    const port = PORTS.find((p) => !used.has(p));
    if (!port) throw new Error("no free agent port");
    await this.deps.db.query("update sa.agents set api_port = $1 where id = $2", [port, agentId]);
    return port;
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

      const logDir = join(ROOT, ".run", "agents");
      mkdirSync(logDir, { recursive: true });
      const logFile = join(logDir, `${name}.log`);
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
      child.once("exit", () => {
        this.gateways.delete(agent.id);
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
   * Reasoning source: the pinned Hermes (infra/hermes/VERSION) is read from, in order, the
   * chat-completion message's `reasoning_content` / `reasoning` field. The Responses API
   * reasoning items and Runs API events were not verified against a live gateway here; when the
   * field is absent, reasoning stays empty (the UI shows tool steps only) apart from <think> blocks.
   */
  async chat(agent: RuntimeAgent, chatId: string, messages: ChatMessage[]): Promise<ChatResult> {
    const g = this.gateways.get(agent.id);
    const port = g?.port ?? (await this.allocatePort(agent.id));
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${hermesApiKey(agent.id)}`,
        "x-hermes-session-id": `${agent.id}:${chatId}`,
      },
      body: JSON.stringify({ model: "hermes-agent", messages }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`hermes chat failed: ${res.status}`);
    const data = (await res.json()) as {
      choices?: {
        message?: { content?: string; reasoning_content?: string; reasoning?: string };
      }[];
    };
    const msg = data.choices?.[0]?.message ?? {};
    const split = splitThink(msg.content ?? "");
    const field = (msg.reasoning_content ?? msg.reasoning ?? "").trim();
    const reasoning = [field, split.reasoning].filter(Boolean).join("\n\n");
    return reasoning ? { content: split.content, reasoning } : { content: split.content };
  }

  async stop(agent: RuntimeAgent): Promise<void> {
    const g = this.gateways.get(agent.id);
    this.status.set(agent.id, { status: "stopped" });
    if (!g) return;
    this.gateways.delete(agent.id);
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
      try {
        process.kill(-(g.child.pid ?? 0), "SIGTERM");
      } catch {
        g.child.kill("SIGTERM");
      }
    }
    this.gateways.clear();
  }
}

function lastLine(file: string): string {
  try {
    return readFileSync(file, "utf8").trim().split("\n").at(-1) ?? "";
  } catch {
    return "";
  }
}
