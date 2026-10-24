// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { ActivityBody, Agent, Chat, ChatMember } from "@sa/protocol";
import { ROSTER } from "@sa/protocol/roster";
import { useAgents } from "../state/agents";

export const memberOfDevice = (chat: Chat | undefined, device: string): ChatMember | undefined =>
  chat?.members.find((m) => m.devices.some((d) => d.device_id === device));

/** Name for an agent device when the chat is not known (ids look like `dev-<roster id>` in fixtures). */
export function nameOfDevice(chat: Chat | undefined, device: string): string {
  const m = memberOfDevice(chat, device);
  if (m) return m.display_name;
  const tail = device.split("-").pop() ?? "";
  return ROSTER.find((r) => r.id === tail)?.name ?? "An agent";
}

/** Agents the user can see (workspace and own personal ones); empty until the shared list loads. */
const NONE: Agent[] = [];
export function useWorkspaceAgents(): Agent[] {
  return useAgents().agents ?? NONE;
}

/** "Workspace agent" or "Ana's agent": whose agent a chat member is. */
export function agentLabel(m: ChatMember): string {
  return m.agent_scope === "workspace"
    ? "Workspace agent"
    : `${m.owner_display_name ?? "Someone"}'s agent`;
}

/**
 * The one description of what an agent is doing, in three registers: "line" for the live bubble
 * (with the tool name), "speech" for the screen-reader announcement (never drafts or tool names)
 * and "rail" for the activity rail (no name, the rail shows it next to an avatar).
 * Null for phases that are not live (done, stopped, writing in the rail).
 */
export function describePhase(
  b: ActivityBody,
  name: string,
  mode: "line" | "speech" | "rail",
): string | null {
  const ahead = b.ahead ?? 0;
  switch (b.phase) {
    case "queued":
      if (mode === "rail")
        return b.ahead === undefined ? "waiting its turn" : `waiting its turn, ${ahead} ahead`;
      return mode === "line"
        ? `${name} · queued, ${ahead} ahead`
        : `${name}: queued, ${ahead} ahead`;
    case "thinking":
      return mode === "rail" ? "thinking" : `${name} is thinking`;
    case "reading":
      if (mode === "rail") return "reading the chat";
      return mode === "line" ? `${name} · reading ${b.count ?? 0} messages` : `${name} is reading`;
    case "tool":
      if (mode === "rail") return b.tool ? `using ${b.tool}` : "using";
      return mode === "line"
        ? `${name} · calling \`${b.tool ?? "a tool"}\``
        : `${name} is using a tool`;
    case "writing":
      return mode === "speech" ? `${name} is writing` : mode === "rail" ? "writing" : null;
    case "error":
      return mode === "rail" ? null : `${name} couldn't answer`;
    default:
      return null;
  }
}

/** Agents (workspace or your own personal ones) that are not members of the chat. */
export const agentsOutside = (chat: Chat, all: Agent[]): Agent[] =>
  all.filter((a) => !chat.members.some((m) => m.member_id === a.id));

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
