import { afterEach, describe, expect, it } from "vitest";
import type { AgentRuntime, ChatMessage, ChatResult } from "../src/agents/runtime.js";
import { forceFirstTool, setForceFirstTool } from "../src/agents/turn-policy.js";
import {
  addPersonalAgent,
  createWorld,
  person,
  rekey,
  sleep,
  startChat,
  type World,
} from "./teammates-fixture.js";

let w: World;
afterEach(async () => {
  await w?.close();
});

describe("background host calls for call notes", () => {
  it("sendAs resolves the relayed id; complete never forces a tool, restores it, and waits behind a human turn", async () => {
    const log: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runtime: AgentRuntime = {
      ensureStarted: async () => {},
      stop: async () => {},
      stopAll: async () => {},
      chat: async (agent, _chat, messages: ChatMessage[]): Promise<ChatResult> => {
        const last = messages[messages.length - 1]?.content ?? "";
        if (last === "summarise") {
          log.push(`complete:force=${forceFirstTool(agent.id)}`);
          return { content: "<think>hmm</think>NOTES" };
        }
        log.push("human:start");
        await gate;
        log.push("human:end");
        return { content: "done" };
      },
    };
    w = await createWorld(runtime);
    const ana = await person(w, "ana");
    const chat = await startChat(w, ana, "Ops room");
    const scout = await addPersonalAgent(w, ana, chat, "Scout");
    await rekey(w, chat, ana, [ana], [scout]);

    // sendAs
    const id = await w.host.sendAs?.(scout.id, chat, { type: "text", text: "from sendAs" });
    await expect
      .poll(() => ana.seen.find((m) => m.id === id)?.senderDevice, { timeout: 5000 })
      .toBe(scout.device_id);
    expect(typeof id).toBe("string");
    await expect(
      w.host.sendAs?.("no-such-agent", chat, { type: "text", text: "x" }),
    ).rejects.toThrow("agent_not_ready");

    // complete: forced tool is off during the call and restored after it
    setForceFirstTool(scout.id, true);
    const done = await w.host.complete?.(scout.id, "call-notes:n1", [
      { role: "user", content: "summarise" },
    ]);
    expect(done).toBe("NOTES");
    expect(log).toEqual(["complete:force=false"]);
    expect(forceFirstTool(scout.id)).toBe(true);

    // behind a human turn
    log.length = 0;
    await ana.engine.sendText(chat, "@Scout please look at this");
    await expect.poll(() => log, { timeout: 8000 }).toEqual(["human:start"]);
    let finished = false;
    const pending = w.host
      .complete?.(scout.id, "call-notes:n1", [{ role: "user", content: "summarise" }])
      .then((v) => {
        finished = true;
        return v;
      });
    await sleep(500);
    expect(finished).toBe(false);
    expect(log).toEqual(["human:start"]);
    release();
    expect(await pending).toBe("NOTES");
    expect(log).toEqual(["human:start", "human:end", "complete:force=false"]);
  }, 25000);
});
