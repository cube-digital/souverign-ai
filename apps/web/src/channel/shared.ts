// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { Agent, Chat, ChatMember } from "@sa/protocol";
import { ROSTER } from "@sa/protocol/roster";
import { useEffect, useState } from "react";
import { agents as fetchAgents } from "../api";

export const memberOfDevice = (chat: Chat | undefined, device: string): ChatMember | undefined =>
  chat?.members.find((m) => m.devices.some((d) => d.device_id === device));

/** Name for an agent device when the chat is not known (ids look like `dev-<roster id>` in fixtures). */
export function nameOfDevice(chat: Chat | undefined, device: string): string {
  const m = memberOfDevice(chat, device);
  if (m) return m.display_name;
  const tail = device.split("-").pop() ?? "";
  return ROSTER.find((r) => r.id === tail)?.name ?? "An agent";
}

/** Workspace agents the user can see, loaded once per mounted consumer. */
export function useWorkspaceAgents(): Agent[] {
  const [list, setList] = useState<Agent[]>([]);
  useEffect(() => {
    let live = true;
    fetchAgents()
      .then((a) => {
        if (live) setList(a);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return list;
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
