import { afterEach, describe, expect, it } from "vitest";
import { EchoRuntime } from "../src/agents/echo.js";
import { addTurnHooks, clearTurnHooks } from "../src/agents/turn-hooks.js";
import { registerGatedTool } from "../src/approvals/service.js";
import { clearRegisteredTools, registerTools, setToolDeps } from "../src/mcp/registry.js";
import {
  addPersonalAgent,
  createWorld,
  metaOf,
  person,
  rekey,
  startChat,
  textsFrom,
  type World,
} from "./teammates-fixture.js";

let w: World;
afterEach(async () => {
  clearTurnHooks();
  clearRegisteredTools();
  await w?.close();
});

describe("gated tool traces are stripped after all hooks", () => {
  it("drops meta.trace naming a gated tool with no approvals hook, and with a later hook", async () => {
    w = await createWorld(new EchoRuntime());
    const ana = await person(w, "ana");
    const chat = await startChat(w, ana, "Ops room");
    const scout = await addPersonalAgent(w, ana, chat, "Scout");
    await rekey(w, chat, ana, [ana], [scout]);
    setToolDeps({ db: w.db, opsSimUrl: "http://127.0.0.1:1", toolLog: w.toolLog });
    registerGatedTool("gated_probe", {
      executor: {
        editable: ["q"],
        alwaysAllowed: true,
        stamp: true,
        validate: async (a: Record<string, unknown>) => a,
        preview: () => ({ title: "Probe", target: "t", fields: [], leaves_chat: false }),
        execute: async () => "done",
      },
    });
    registerTools(
      ["general"],
      [
        {
          name: "gated_probe",
          description: "Gated probe",
          properties: { q: { type: "string" } },
          required: ["q"],
          run: async (_ctx, args) => `probed ${String(args.q)}`,
        },
      ],
    );

    // No approvals hook registered at all.
    await ana.engine.sendText(chat, '@Scout !tool gated_probe {"q":"secret"}');
    await expect.poll(() => textsFrom(ana, scout.device_id).length, { timeout: 8000 }).toBe(1);
    expect(metaOf(textsFrom(ana, scout.device_id)[0]!)?.trace).toBeUndefined();

    // A hook that runs after any approvals hook would have run.
    addTurnHooks({
      name: "zz-last",
      beforeReply: async () => ({ action: "post", meta: { model: "last-hook" } }),
    });
    await ana.engine.sendText(chat, '@Scout !tool gated_probe {"q":"secret2"}');
    await expect.poll(() => textsFrom(ana, scout.device_id).length, { timeout: 8000 }).toBe(2);
    const second = metaOf(textsFrom(ana, scout.device_id)[1]!);
    expect(second?.trace).toBeUndefined();
    expect(second?.model).toBe("last-hook");
  }, 30000);
});
