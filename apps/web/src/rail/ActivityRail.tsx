// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { memo } from "react";
import { AgentAvatar, EmptyState } from "../ds";
import { timeOf } from "../lib/format";
import { useActivity, useSession } from "../state/session";

const PHASE: Record<string, string> = {
  queued: "waiting its turn",
  thinking: "thinking",
  reading: "reading the chat",
  tool: "using",
  writing: "writing",
};

/** Live status of the working agents, then this chat's last 10 agent replies with receipts. */
export function ActivityRail({ chatId }: { chatId: string }) {
  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-3">
      <WorkingNow chatId={chatId} />
      <RecentReplies chatId={chatId} />
    </div>
  );
}

function WorkingNow({ chatId }: { chatId: string }) {
  const { chats } = useSession();
  const live = useActivity()[chatId] ?? {};
  const agents = (chats.find((c) => c.id === chatId)?.members ?? []).filter(
    (m) => m.member_type === "agent",
  );
  const working = agents.flatMap((a) =>
    a.devices.flatMap((d) => {
      const body = live[d.device_id]?.body;
      const label = body ? PHASE[body.phase] : undefined;
      if (!body || !label) return [];
      const text =
        body.phase === "tool" && body.tool
          ? `${label} ${body.tool}`
          : body.phase === "queued" && body.ahead !== undefined
            ? `${label}, ${body.ahead} ahead`
            : label;
      return [{ key: d.device_id, agent: a, text }];
    }),
  );
  return (
    <section aria-label="Working now" className="flex flex-col gap-1">
      {working.map(({ key, agent, text }) => (
        <div key={key} className="flex items-center gap-2 text-[13px]">
          <AgentAvatar name={agent.display_name} id={agent.member_id} size={20} />
          <span className="text-text-0">{agent.display_name}</span>
          <span className="text-text-2">{text}</span>
        </div>
      ))}
      {working.length === 0 && <EmptyState>No agent is working right now.</EmptyState>}
    </section>
  );
}

const RecentReplies = memo(function RecentReplies({ chatId }: { chatId: string }) {
  const { chats, messages } = useSession();
  const agents = (chats.find((c) => c.id === chatId)?.members ?? []).filter(
    (m) => m.member_type === "agent",
  );
  const deviceOwner = new Map(
    agents.flatMap((a) => a.devices.map((d) => [d.device_id, a] as const)),
  );
  const replies = (messages[chatId] ?? [])
    .flatMap((m) => {
      const a = deviceOwner.get(m.senderDevice);
      return a && m.body?.type === "text" ? [{ m, a, body: m.body }] : [];
    })
    .slice(-10)
    .reverse();
  return (
    <section aria-label="Recent replies" className="flex flex-col gap-2">
      {replies.map(({ m, a, body }) => {
        const tools = body.meta?.tools ?? [];
        const ms = body.meta?.ms;
        const took = ms === undefined ? "" : ` · ${(ms / 1000).toFixed(1)} s`;
        return (
          <div key={m.id} className="rounded-md border border-border-soft bg-bg-1 px-3 py-2">
            <div className="flex justify-between text-[12px] text-text-2">
              <span>{a.display_name}</span>
              <span>{timeOf(m.ts)}</span>
            </div>
            <p className="mt-1 line-clamp-3 text-[13px] text-text-0">{body.text}</p>
            <p className="mt-1 text-[12px] text-text-2">
              {tools.length > 0 ? `Used ${tools.join(", ")}${took}` : `Answered${took}`}
            </p>
          </div>
        );
      })}
    </section>
  );
});
