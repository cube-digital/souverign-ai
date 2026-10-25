import { EchoRuntime } from "../src/agents/echo.js";
import { clearTurnHooks } from "../src/agents/turn-hooks.js";
import { clearRegisteredTools, setToolDeps } from "../src/mcp/registry.js";
import { setMemoryForTests } from "../src/memory/client.js";
import { loadPlugins } from "../src/plugin-loader.js";
import { FakeMemory } from "./fakes/memory-fake.js";
import { createWorld, person, startChat, type World } from "./teammates-fixture.js";

export const GATE_PLUGINS = ["approvals", "memory-tools", "share-gate"];
export const DOC_TEXT = "The termination notice period is 47 days";
export const RECALL_DIRECTIVE = '!tool memory_recall {"query":"termination notice period"}';
export const NO_HITS_REPLY = "echo: memory_recall -> No memories matched.";

/** Real host + echo runtime + FakeMemory, with the approval, memory and share-gate plugins
 * initialised in name order. ana and bob share the chat `Project`. */
export async function gateWorld() {
  clearTurnHooks();
  clearRegisteredTools();
  const mem = new FakeMemory();
  setMemoryForTests(mem);
  const w: World = await createWorld(new EchoRuntime(), ["ana", "bob"]);
  setToolDeps({ db: w.db, opsSimUrl: "http://127.0.0.1:1", toolLog: w.toolLog });
  const plugins = (await loadPlugins()).filter((p) => GATE_PLUGINS.includes(p.name));
  if (plugins.map((p) => p.name).join() !== GATE_PLUGINS.join())
    throw new Error(`missing plugins, found: ${plugins.map((p) => p.name).join()}`);
  for (const p of plugins)
    await p.init?.({
      db: w.db,
      relayAdmin: { setMember: async () => {} },
      relayInternalUrl: "http://127.0.0.1:1",
      ticketFor: async () => "",
      opsSimUrl: "http://127.0.0.1:1",
      agentHost: w.host,
      log: () => {},
    });
  const ana = await person(w, "ana");
  const bob = await person(w, "bob");
  const chat = await startChat(w, ana, "Project", [bob]);

  /** Taught knowledge in the agent's private space (origin_chat_id empty), with its teacher. */
  const teach = async (agentId: string, itemId: string, taughtBy: string, text = DOC_TEXT) => {
    await w.db.query(
      "insert into sa.knowledge_items (id, agent_id, kind, title, taught_by) values ($1,$2,'document','contract.pdf',$3)",
      [itemId, agentId, taughtBy],
    );
    await mem.ingest({
      namespace: `agent:${agentId}`,
      kind: "knowledge",
      origin_chat_id: null,
      source: { type: "doc", id: itemId, title: "contract.pdf", ts: Date.UTC(2026, 9, 21) },
      text,
    });
  };
  const setShare = (agentId: string, mode: "always" | "ask" | "never") =>
    w.db.query("update sa.agents set share_private_in_chats = $1 where id = $2", [mode, agentId]);
  const approvals = () =>
    w.db.query<{
      id: string;
      status: string;
      tool: string;
      kind: string;
      approver_user_id: string;
      requester_user_id: string | null;
      args: { text: string; question: string };
      preview: { title: string };
    }>(
      "select id, status, tool, kind, approver_user_id, requester_user_id, args, preview from sa.approvals order by created_at",
    );
  const close = async () => {
    for (const p of plugins) await p.stop?.();
    clearTurnHooks();
    clearRegisteredTools();
    setMemoryForTests(undefined);
    await w.close();
  };
  return { w, mem, ana, bob, chat, teach, setShare, approvals, close };
}
