import type { ChatMessage } from "@sa/client";
import type { MessageBody } from "@sa/protocol";
import { expect, it } from "vitest";
import { buildView } from "../src/state/threads";

const msg = (id: string, seq: number, senderDevice: string, body: MessageBody): ChatMessage => ({
  id,
  chatId: "c1",
  seq,
  ts: seq,
  senderDevice,
  epoch: 1,
  status: "ok",
  body,
});
const text = (id: string, seq: number, reply_to?: string) =>
  msg(id, seq, "dev-a", { type: "text", text: `t${id}`, ...(reply_to ? { reply_to } : {}) });
const react = (id: string, seq: number, dev: string, emoji: string, op: "add" | "remove") =>
  msg(id, seq, dev, { type: "reaction", target: "root", emoji, op });

it("groups replies under their root sorted by seq and keeps reaction bodies out of both lists", () => {
  const view = buildView(
    [
      text("r2", 5, "root"),
      text("root", 1),
      react("x1", 3, "dev-a", "👍", "add"),
      text("r1", 2, "root"),
      text("other", 4),
    ],
    "dev-a",
  );
  expect(view.top.map((m) => m.id)).toEqual(["root", "other"]);
  expect(view.replies.get("root")?.map((m) => m.id)).toEqual(["r1", "r2"]);
  expect(view.replies.size).toBe(1);
});

it("folds reactions by last op per (target, emoji, device) and flags mine", () => {
  const view = buildView(
    [
      text("root", 1),
      react("a1", 2, "dev-a", "👍", "add"),
      react("b1", 3, "dev-b", "👍", "add"),
      react("a2", 4, "dev-a", "👍", "remove"),
      react("b2", 5, "dev-b", "❤️", "add"),
      react("a3", 6, "dev-a", "🎉", "add"),
      react("a4", 7, "dev-a", "🎉", "remove"),
      react("a5", 8, "dev-a", "🎉", "add"),
    ],
    "dev-a",
  );
  const rs = view.reactions.get("root") ?? [];
  const by = (e: string) => rs.find((r) => r.emoji === e);
  expect(rs).toHaveLength(3);
  expect(by("👍")).toEqual({ emoji: "👍", count: 1, mine: false });
  expect(by("❤️")).toEqual({ emoji: "❤️", count: 1, mine: false });
  expect(by("🎉")).toEqual({ emoji: "🎉", count: 1, mine: true });
});
