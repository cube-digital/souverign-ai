import { expect, it } from "vitest";
import { expandSlash } from "../src/composer/slash";

const agents = [
  { name: "Scribe", inChat: true },
  { name: "Ops", inChat: true },
  { name: "Dev", inChat: false },
];
const chatCtx = { inThread: false, agents };

it("expands the five commands into visible agent requests and reports unusable input", () => {
  expect(expandSlash("/summarize", chatCtx)).toEqual({ text: "@Scribe summarize this chat" });
  expect(expandSlash("/summarize", { ...chatCtx, inThread: true })).toEqual({
    text: "@Scribe summarize this thread",
  });
  expect(expandSlash("/catchup", chatCtx)).toEqual({ text: "@Scribe what did I miss?" });
  expect(expandSlash("/standup", chatCtx)).toEqual({
    text: "@Scribe write a standup for today from this chat: done, next, blockers",
  });
  expect(expandSlash("/ask Ops why is db-2 lagging?", chatCtx)).toEqual({
    text: "@Ops why is db-2 lagging?",
  });
  expect(expandSlash("/access Ops", chatCtx)).toEqual({
    text: "@Ops what can you access here?",
  });

  expect(expandSlash("/ask Nobody hello", chatCtx)).toEqual({ error: "No agent called Nobody" });

  // No agent given: every agent in the chat is named, and none that is outside it.
  const all = expandSlash("/access", chatCtx);
  expect(all).toEqual({ text: expect.stringContaining("@Scribe") });
  expect(all).toEqual({ text: expect.stringContaining("@Ops") });
  expect(all).toEqual({ text: expect.not.stringContaining("@Dev") });
  expect(all).toEqual({ text: expect.stringContaining("what can you access here?") });

  expect(expandSlash("/access", { inThread: false, agents: [] })).toEqual({
    error: "No agents in this chat",
  });
});
