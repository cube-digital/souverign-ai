import type { ChatMessage } from "@sa/client";

export type Reaction = { emoji: string; count: number; mine: boolean };
export type ChatView = {
  /** Messages that are not replies and not reactions, by seq. */
  top: ChatMessage[];
  /** Replies grouped by thread root id, by seq. */
  replies: Map<string, ChatMessage[]>;
  /** Reactions per target message id. */
  reactions: Map<string, Reaction[]>;
};

const same = <T>(a: T[], b: T[], eq: (x: T, y: T) => boolean) =>
  a.length === b.length && a.every((x, i) => eq(x, b[i] as T));

/** Pass the previous view to keep unchanged lists and rows referentially equal (memoised rows skip re-render). */
export function buildView(messages: ChatMessage[], myDevice: string, prev?: ChatView): ChatView {
  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  const ids = new Set(sorted.map((m) => m.id));
  const top: ChatMessage[] = [];
  const replies = new Map<string, ChatMessage[]>();
  // target -> emoji -> sender device -> last op (messages are in seq order, so the last write wins)
  const ops = new Map<string, Map<string, Map<string, "add" | "remove">>>();

  for (const m of sorted) {
    const body = m.body;
    if (body?.type === "reaction") {
      const byEmoji = ops.get(body.target) ?? new Map<string, Map<string, "add" | "remove">>();
      const byDevice = byEmoji.get(body.emoji) ?? new Map<string, "add" | "remove">();
      byDevice.set(m.senderDevice, body.op);
      byEmoji.set(body.emoji, byDevice);
      ops.set(body.target, byEmoji);
      continue;
    }
    const root = body && (body.type === "text" || body.type === "file") ? body.reply_to : undefined;
    // A reply whose root this device never received (it joined later) stays visible at top level.
    if (root && ids.has(root)) {
      const list = replies.get(root) ?? [];
      list.push(m);
      replies.set(root, list);
    } else {
      top.push(m);
    }
  }

  const reactions = new Map<string, Reaction[]>();
  for (const [target, byEmoji] of ops) {
    const list: Reaction[] = [];
    for (const [emoji, byDevice] of byEmoji) {
      const active = [...byDevice].filter(([, op]) => op === "add").map(([dev]) => dev);
      if (active.length > 0) {
        list.push({ emoji, count: active.length, mine: active.includes(myDevice) });
      }
    }
    if (list.length === 0) continue;
    const old = prev?.reactions.get(target);
    const rows = old
      ? list.map(
          (r) =>
            old.find((o) => o.emoji === r.emoji && o.count === r.count && o.mine === r.mine) ?? r,
        )
      : list;
    reactions.set(target, old && same(rows, old, (x, y) => x === y) ? old : rows);
  }
  for (const [root, list] of replies) {
    const old = prev?.replies.get(root);
    if (old && same(list, old, (x, y) => x === y)) replies.set(root, old);
  }
  return {
    top: prev && same(top, prev.top, (x, y) => x === y) ? prev.top : top,
    replies,
    reactions,
  };
}
